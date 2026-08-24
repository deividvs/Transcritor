import { existsSync } from 'node:fs'
import path from 'node:path'

import { NextResponse } from 'next/server'

import { getJob, jobDir, updateJob } from '@/lib/jobs'
import { currentMode } from '@/lib/mode'
import { runRetranscribe } from '@/lib/pipeline'
import { TERMINAL, type JobOptions } from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/**
 * Re-transcreve o job reaproveitando o `audio.mp3` já em disco. Útil para
 * corrigir o idioma ou trocar de modelo sem baixar nem converter de novo.
 */
export async function POST(request: Request, { params }: Ctx) {
  const { id } = await params

  if (currentMode() === 'cloud') {
    return NextResponse.json(
      { error: 'Re-transcrever exige o MP3 em disco, o que só existe no modo local.' },
      { status: 400 },
    )
  }

  const job = getJob(id)
  if (!job) return NextResponse.json({ error: 'Job não encontrado.' }, { status: 404 })

  if (!TERMINAL.includes(job.stage)) {
    return NextResponse.json({ error: 'Esse job ainda está em andamento.' }, { status: 409 })
  }

  const stored = job.files.mp3
  const mp3 = stored ? path.join(jobDir(id), path.basename(stored)) : null
  if (!mp3 || !existsSync(mp3)) {
    return NextResponse.json(
      { error: 'O MP3 desse job não está mais em disco. Rode a transcrição de novo desde a origem.' },
      { status: 404 },
    )
  }

  const body = (await request.json().catch(() => ({}))) as { options?: Partial<JobOptions> }
  const options: JobOptions = { ...job.options, ...body.options }

  // Zera o resultado anterior: o card volta a mostrar progresso e é substituído
  // pelo novo texto quando terminar.
  updateJob(
    id,
    {
      options,
      stage: 'transcribing',
      progress: 0,
      message: 'Re-transcrevendo…',
      segments: [],
      transcript: '',
      detectedLanguage: undefined,
      error: undefined,
    },
    true,
  )

  const fresh = getJob(id)!
  void runRetranscribe(fresh, mp3)

  return NextResponse.json({ job: fresh }, { status: 202 })
}
