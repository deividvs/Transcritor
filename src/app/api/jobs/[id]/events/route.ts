import { emitterFor, getJob } from '@/lib/jobs'
import { TERMINAL, type Job } from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

export async function GET(request: Request, { params }: Ctx) {
  const { id } = await params
  const job = getJob(id)
  if (!job) return new Response('Job não encontrado', { status: 404 })

  const emitter = emitterFor(id)
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false

      const push = (chunk: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          cleanup()
        }
      }

      const onUpdate = (updated: Job) => {
        push(`data: ${JSON.stringify(updated)}\n\n`)
        if (TERMINAL.includes(updated.stage)) {
          // pequena folga para o último frame sair antes de fechar
          setTimeout(cleanup, 300)
        }
      }

      const heartbeat = setInterval(() => push(': keep-alive\n\n'), 15_000)

      function cleanup() {
        if (closed) return
        closed = true
        clearInterval(heartbeat)
        emitter.off('update', onUpdate)
        try {
          controller.close()
        } catch {
          /* já fechado */
        }
      }

      // estado atual imediatamente, para o cliente não esperar o próximo evento
      push(`data: ${JSON.stringify(job)}\n\n`)
      if (TERMINAL.includes(job.stage)) {
        setTimeout(cleanup, 100)
        return
      }

      emitter.on('update', onUpdate)
      request.signal.addEventListener('abort', cleanup)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
