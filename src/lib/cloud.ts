import { cloudKey } from './mode'
import type { Segment } from './types'

const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions'

export type CloudResult = {
  transcript: string
  segments: Segment[]
  language?: string
  duration?: number
}

type GroqVerbose = {
  text?: string
  language?: string
  duration?: number
  segments?: { start: number; end: number; text: string }[]
}

/**
 * A Groq aceita `file` (upload) ou `url` (ela mesma baixa a mídia). Usar `url`
 * evita que o arquivo passe pela nossa função — importante porque a Vercel
 * limita o corpo do request a 4,5 MB.
 */
export type CloudInput = { kind: 'file'; file: File } | { kind: 'url'; url: string }

export async function transcribeInCloud(
  input: CloudInput,
  opts: { model: string; language?: string },
): Promise<CloudResult> {
  const key = cloudKey()
  if (!key) {
    throw new Error(
      'A transcrição na nuvem precisa da variável GROQ_API_KEY. ' +
        'Gere uma chave em console.groq.com e configure no projeto.',
    )
  }

  const form = new FormData()
  if (input.kind === 'file') form.append('file', input.file)
  else form.append('url', input.url)
  form.append('model', opts.model)
  form.append('response_format', 'verbose_json')
  if (opts.language) form.append('language', opts.language)

  let response: Response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    })
  } catch (cause) {
    throw new Error(`Não consegui falar com a API da Groq: ${(cause as Error).message}`)
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(groqError(response.status, detail))
  }

  const data = (await response.json()) as GroqVerbose
  const segments: Segment[] = (data.segments ?? []).map((s) => ({
    start: s.start,
    end: s.end,
    text: s.text.trim(),
  }))

  return {
    transcript: (data.text ?? segments.map((s) => s.text).join(' ')).trim(),
    segments,
    language: data.language,
    duration: data.duration,
  }
}

/** Traduz os erros mais comuns da API para algo acionável na interface. */
function groqError(status: number, detail: string) {
  const message = extractMessage(detail)

  if (status === 401) return 'A GROQ_API_KEY é inválida ou foi revogada.'
  if (status === 413) return 'O arquivo é grande demais para a API (limite de 25 MB no plano free).'
  if (status === 429) return 'Limite de uso da Groq atingido. Tente de novo em alguns instantes.'
  if (status === 400 && /url/i.test(message)) {
    return (
      'A Groq não conseguiu baixar essa URL. Ela precisa apontar direto para um arquivo de ' +
      'áudio ou vídeo — páginas do YouTube e Instagram só funcionam no modo local.'
    )
  }
  return message ? `A Groq recusou o pedido (${status}): ${message}` : `A Groq respondeu ${status}.`
}

function extractMessage(detail: string) {
  try {
    const parsed = JSON.parse(detail) as { error?: { message?: string } }
    return parsed.error?.message ?? ''
  } catch {
    return detail.slice(0, 300)
  }
}
