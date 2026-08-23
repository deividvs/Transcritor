import { createReadStream, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

import { getJob, jobDir } from '@/lib/jobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const KINDS: Record<string, { mime: string; ext: string; label: string }> = {
  mp3: { mime: 'audio/mpeg', ext: 'mp3', label: 'audio' },
  video: { mime: 'video/mp4', ext: 'mp4', label: 'video' },
  txt: { mime: 'text/plain; charset=utf-8', ext: 'txt', label: 'transcricao' },
  srt: { mime: 'application/x-subrip; charset=utf-8', ext: 'srt', label: 'legenda' },
  vtt: { mime: 'text/vtt; charset=utf-8', ext: 'vtt', label: 'legenda' },
  json: { mime: 'application/json; charset=utf-8', ext: 'json', label: 'segmentos' },
  tsv: { mime: 'text/tab-separated-values; charset=utf-8', ext: 'tsv', label: 'segmentos' },
}

/** Nome amigável e seguro para o Content-Disposition. */
function slug(value: string) {
  return (
    value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'arquivo'
  )
}

type Ctx = { params: Promise<{ id: string }> }

export async function GET(request: Request, { params }: Ctx) {
  const { id } = await params
  const kind = new URL(request.url).searchParams.get('kind') ?? ''

  const job = getJob(id)
  if (!job) return new Response('Job não encontrado', { status: 404 })

  const spec = KINDS[kind]
  const stored = job.files[kind]
  if (!spec || !stored) return new Response('Arquivo indisponível', { status: 404 })

  // path traversal: só aceitamos o basename registrado pelo pipeline
  const dir = jobDir(id)
  const filePath = path.join(dir, path.basename(stored))
  if (!filePath.startsWith(dir + path.sep) || !existsSync(filePath)) {
    return new Response('Arquivo não encontrado no disco', { status: 404 })
  }

  const ext = path.extname(filePath).slice(1) || spec.ext
  const filename = `${slug(job.title ?? job.id)}-${spec.label}.${ext}`
  const { size } = statSync(filePath)
  const body = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream<Uint8Array>

  return new Response(body, {
    headers: {
      'Content-Type': spec.mime,
      'Content-Length': String(size),
      'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'no-store',
    },
  })
}
