import { NextResponse } from 'next/server'

import { transcribeInCloud, type CloudInput } from '@/lib/cloud'
import { createJob, listJobs, updateJob } from '@/lib/jobs'
import { MAX_UPLOAD_BYTES, cloudKey, currentMode } from '@/lib/mode'
import { runPipeline } from '@/lib/pipeline'
import { DEFAULT_CLOUD_MODEL, DEFAULT_OPTIONS, type JobOptions } from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
/** A Groq leva poucos segundos, mas áudio longo pede folga. */
export const maxDuration = 60

export async function GET() {
  return NextResponse.json({ jobs: listJobs() })
}

export async function POST(request: Request) {
  return currentMode() === 'local' ? postLocal(request) : postCloud(request)
}

/* ---------------------------------------------------------------- local --- */

async function postLocal(request: Request) {
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

/* ---------------------------------------------------------------- nuvem --- */

/**
 * No serverless não há processo de fundo confiável: a função pode congelar
 * assim que responde. Então a transcrição roda dentro do próprio request e o
 * job já volta concluído — sem SSE, sem disco.
 */
async function postCloud(request: Request) {
  if (!cloudKey()) {
    return NextResponse.json(
      {
        error:
          'Este ambiente não tem os binários locais nem a GROQ_API_KEY configurada. ' +
          'Defina GROQ_API_KEY nas variáveis de ambiente do projeto.',
      },
      { status: 503 },
    )
  }

  let input: CloudInput
  let label: string
  let partial: Partial<JobOptions> = {}

  const contentType = request.headers.get('content-type') ?? ''

  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData().catch(() => null)
    const file = form?.get('file')
    if (!form || !(file instanceof File) || file.size === 0) {
      return NextResponse.json({ error: 'Nenhum arquivo recebido.' }, { status: 400 })
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        {
          error:
            `O arquivo tem ${(file.size / 1024 / 1024).toFixed(1)} MB e o limite de upload é ` +
            `${(MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(0)} MB. Comprima o áudio ou informe ` +
            'um link direto para o arquivo — por link não há limite de tamanho.',
        },
        { status: 413 },
      )
    }
    input = { kind: 'file', file }
    label = file.name
    partial = parseOptions(form.get('options'))
  } else {
    const body = (await request.json().catch(() => ({}))) as {
      url?: string
      options?: Partial<JobOptions>
    }
    const url = body.url?.trim()
    if (!url || !/^https?:\/\//i.test(url)) {
      return NextResponse.json({ error: 'Informe uma URL válida começando com http:// ou https://' }, { status: 400 })
    }
    input = { kind: 'url', url }
    label = url
    partial = body.options ?? {}
  }

  const options: JobOptions = {
    ...DEFAULT_OPTIONS,
    model: DEFAULT_CLOUD_MODEL,
    ...partial,
  }

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

function parseOptions(raw: FormDataEntryValue | null): Partial<JobOptions> {
  if (typeof raw !== 'string' || !raw) return {}
  try {
    return JSON.parse(raw) as Partial<JobOptions>
  } catch {
    return {}
  }
}
