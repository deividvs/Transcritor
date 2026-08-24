import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline as streamPipeline } from 'node:stream/promises'

import { NextResponse } from 'next/server'

import { transcribeInCloud, type CloudInput } from '@/lib/cloud'
import { createJob, jobDir, listJobs, updateJob } from '@/lib/jobs'
import { MAX_LOCAL_UPLOAD_BYTES, MAX_UPLOAD_BYTES, cloudKey, currentMode } from '@/lib/mode'
import { runPipeline, runPipelineFromFile } from '@/lib/pipeline'
import { DEFAULT_CLOUD_MODEL, DEFAULT_OPTIONS, type JobOptions } from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
/** A Groq leva poucos segundos, mas áudio longo pede folga. */
export const maxDuration = 60

export async function GET() {
  return NextResponse.json({ jobs: listJobs() })
}

/**
 * Duas entradas: JSON com `url`, ou o arquivo cru no corpo (o nome vai na query).
 * Corpo cru em vez de multipart porque assim dá para escrever direto em disco
 * por streaming, sem carregar um vídeo inteiro na memória.
 */
export async function POST(request: Request) {
  const isJson = (request.headers.get('content-type') ?? '').includes('application/json')
  const cloud = currentMode() === 'cloud'

  if (isJson) return cloud ? postCloudUrl(request) : postLocalUrl(request)
  return cloud ? postCloudFile(request) : postLocalFile(request)
}

/* ------------------------------------------------------------ helpers --- */

function readQuery(request: Request) {
  const params = new URL(request.url).searchParams
  const filename = params.get('filename')?.trim() || 'arquivo'
  let partial: Partial<JobOptions> = {}
  try {
    partial = JSON.parse(params.get('options') ?? '{}') as Partial<JobOptions>
  } catch {
    /* opções inválidas: cai no padrão */
  }
  return { filename, partial }
}

/** Só o basename e sem caracteres de caminho, para não escapar da pasta do job. */
function safeName(filename: string) {
  const base = path.basename(filename).replace(/[/\\]/g, '')
  return base || 'arquivo'
}

function noKey() {
  return NextResponse.json(
    {
      error:
        'Este ambiente não tem os binários locais nem a GROQ_API_KEY configurada. ' +
        'Defina GROQ_API_KEY nas variáveis de ambiente do projeto.',
    },
    { status: 503 },
  )
}

/* -------------------------------------------------------------- local --- */

async function postLocalUrl(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    url?: string
    options?: Partial<JobOptions>
  }

  const url = body.url?.trim()
  if (!url || !/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: 'Informe uma URL válida começando com http:// ou https://' }, { status: 400 })
  }

  const options: JobOptions = { ...DEFAULT_OPTIONS, ...body.options }
  const job = createJob(url, options)
  updateJob(job.id, { mode: 'local' })

  // Fire-and-forget: o progresso chega pelo SSE, não pela resposta HTTP.
  void runPipeline(job)

  return NextResponse.json({ job }, { status: 201 })
}

async function postLocalFile(request: Request) {
  if (!request.body) {
    return NextResponse.json({ error: 'Nenhum arquivo recebido.' }, { status: 400 })
  }

  // Content-Length chega antes do corpo: recusamos cedo, sem gravar nada.
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_LOCAL_UPLOAD_BYTES) {
    return NextResponse.json(
      {
        error:
          `O arquivo tem ${(declared / 1024 / 1024).toFixed(0)} MB e o limite é ` +
          `${(MAX_LOCAL_UPLOAD_BYTES / 1024 / 1024).toFixed(0)} MB.`,
      },
      { status: 413 },
    )
  }

  const { filename, partial } = readQuery(request)
  const options: JobOptions = { ...DEFAULT_OPTIONS, ...partial }
  const job = createJob(filename, options)

  const name = safeName(filename)
  const ext = path.extname(name).slice(1).toLowerCase() || 'bin'
  const dir = jobDir(job.id)
  const target = path.join(dir, `source.${ext}`)

  updateJob(
    job.id,
    { mode: 'local', title: name, stage: 'downloading', progress: 1, message: 'Recebendo o arquivo…' },
    true,
  )

  try {
    fs.mkdirSync(dir, { recursive: true })
    // Streaming: um vídeo de 2 GB nunca fica inteiro na memória.
    await streamPipeline(
      Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0]),
      fs.createWriteStream(target),
    )
  } catch (error) {
    updateJob(
      job.id,
      {
        stage: 'error',
        message: 'Falhou',
        error: `Não consegui salvar o arquivo: ${error instanceof Error ? error.message : String(error)}`,
      },
      true,
    )
    return NextResponse.json({ job }, { status: 201 })
  }

  const { size } = fs.statSync(target)
  if (size === 0) {
    updateJob(job.id, { stage: 'error', message: 'Falhou', error: 'O arquivo chegou vazio.' }, true)
    return NextResponse.json({ job }, { status: 201 })
  }

  if (options.keepVideo) {
    updateJob(job.id, { files: { ...job.files, video: path.basename(target) } }, true)
  }

  void runPipelineFromFile(job, target)

  return NextResponse.json({ job }, { status: 201 })
}

/* -------------------------------------------------------------- nuvem --- */

/**
 * No serverless não há processo de fundo confiável: a função pode congelar
 * assim que responde. Então a transcrição roda dentro do próprio request e o
 * job já volta concluído — sem SSE, sem disco.
 */
async function postCloudUrl(request: Request) {
  if (!cloudKey()) return noKey()

  const body = (await request.json().catch(() => ({}))) as {
    url?: string
    options?: Partial<JobOptions>
  }
  const url = body.url?.trim()
  if (!url || !/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: 'Informe uma URL válida começando com http:// ou https://' }, { status: 400 })
  }

  return finishCloud({ kind: 'url', url }, url, body.options ?? {})
}

async function postCloudFile(request: Request) {
  if (!cloudKey()) return noKey()

  const { filename, partial } = readQuery(request)
  const buffer = await request.arrayBuffer().catch(() => null)

  if (!buffer || buffer.byteLength === 0) {
    return NextResponse.json({ error: 'Nenhum arquivo recebido.' }, { status: 400 })
  }
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      {
        error:
          `O arquivo tem ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB e o limite de upload é ` +
          `${(MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(0)} MB. Comprima o áudio ou informe ` +
          'um link direto para o arquivo — por link não há limite de tamanho.',
      },
      { status: 413 },
    )
  }

  const file = new File([buffer], safeName(filename))
  return finishCloud({ kind: 'file', file }, safeName(filename), partial)
}

async function finishCloud(input: CloudInput, label: string, partial: Partial<JobOptions>) {
  const options: JobOptions = { ...DEFAULT_OPTIONS, model: DEFAULT_CLOUD_MODEL, ...partial }
  const job = createJob(label, options)
  updateJob(job.id, { mode: 'cloud', stage: 'transcribing', progress: 30, message: 'Transcrevendo na Groq…' })

  try {
    const result = await transcribeInCloud(input, {
      model: options.model,
      language: options.language || undefined,
    })

    updateJob(job.id, {
      stage: 'done',
      progress: 100,
      message: 'Concluído',
      title: label,
      extractor: 'Groq',
      duration: result.duration,
      detectedLanguage: result.language,
      transcript: result.transcript,
      segments: result.segments,
    })
  } catch (error) {
    updateJob(job.id, {
      stage: 'error',
      progress: 100,
      message: 'Falhou',
      title: label,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  // `job` é o mesmo objeto mutado por updateJob, então já reflete o resultado.
  return NextResponse.json({ job }, { status: 201 })
}
