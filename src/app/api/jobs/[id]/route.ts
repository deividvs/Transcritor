import { NextResponse } from 'next/server'
import { deleteJob, getJob } from '@/lib/jobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: Ctx) {
  const { id } = await params
  const job = getJob(id)
  if (!job) return NextResponse.json({ error: 'Job não encontrado' }, { status: 404 })
  return NextResponse.json({ job })
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const { id } = await params
  if (!getJob(id)) return NextResponse.json({ error: 'Job não encontrado' }, { status: 404 })
  deleteJob(id)
  return NextResponse.json({ ok: true })
}
