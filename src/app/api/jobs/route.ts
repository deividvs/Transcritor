import { NextResponse } from 'next/server'

import { missingBins } from '@/lib/bin'
import { createJob, listJobs } from '@/lib/jobs'
import { runPipeline } from '@/lib/pipeline'
import { DEFAULT_OPTIONS, type JobOptions } from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({ jobs: listJobs() })
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    url?: string
    options?: Partial<JobOptions>
  }

  const url = body.url?.trim()
  if (!url || !/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: 'Informe uma URL válida começando com http:// ou https://' }, { status: 400 })
  }

  const missing = missingBins()
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Dependências ausentes: ${missing.join(', ')}. Veja o README.` },
      { status: 503 },
    )
  }

  const options: JobOptions = { ...DEFAULT_OPTIONS, ...body.options }
  const job = createJob(url, options)

  // Fire-and-forget: o progresso chega pelo SSE, não pela resposta HTTP.
  void runPipeline(job)

  return NextResponse.json({ job }, { status: 201 })
}
