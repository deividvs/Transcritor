import { missingBins } from './bin'

/**
 * O app roda em dois modos:
 *
 * - `local`: yt-dlp + ffmpeg + mlx_whisper na máquina. Custo zero, nada sai do
 *   computador, aceita link do YouTube/Instagram. É o modo original.
 * - `cloud`: sem binários (serverless). A transcrição vai para a API da Groq,
 *   que roda o mesmo whisper-large-v3-turbo. Aceita arquivo enviado pelo
 *   usuário ou link direto de mídia — não resolve página do YouTube, porque
 *   isso exige o yt-dlp.
 *
 * A escolha é automática: se os três binários existem, é local.
 */
export type Mode = 'local' | 'cloud'

/** Filesystem só é gravável fora do serverless. */
export const CAN_WRITE_DISK = !process.env.VERCEL

export function hasLocalStack() {
  return missingBins().length === 0
}

export function cloudKey() {
  return process.env.GROQ_API_KEY?.trim() || null
}

export function currentMode(): Mode {
  // No serverless nunca há stack local; ser explícito evita depender de um
  // binário homônimo que por acaso exista na imagem.
  if (process.env.VERCEL) return 'cloud'
  return hasLocalStack() ? 'local' : 'cloud'
}

/**
 * Limite de corpo de request das funções serverless da Vercel (4.5 MB). Ficamos
 * abaixo com folga para os campos de texto do multipart.
 */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024

/** Extensões que a Groq aceita. */
export const ACCEPTED_CLOUD_UPLOAD = '.mp3,.mp4,.m4a,.wav,.webm,.ogg,.flac,.mpeg,.mpga'

/**
 * No modo local quem abre o arquivo é o ffmpeg, então praticamente qualquer
 * container serve — inclusive os de vídeo que a Groq não aceita.
 */
export const ACCEPTED_LOCAL_UPLOAD =
  '.mp3,.mp4,.m4a,.wav,.webm,.ogg,.flac,.mpeg,.mpga,.mov,.mkv,.avi,.wmv,.flv,.aac,.opus,.aiff,.3gp,.ts'

/**
 * Teto do modo local. O arquivo é gravado por streaming, então o limite existe
 * só para evitar encher o disco por engano — não é restrição técnica.
 */
export const MAX_LOCAL_UPLOAD_BYTES = 5000 * 1024 * 1024

export function uploadLimits(mode: Mode) {
  return mode === 'cloud'
    ? { maxBytes: MAX_UPLOAD_BYTES, accept: ACCEPTED_CLOUD_UPLOAD }
    : { maxBytes: MAX_LOCAL_UPLOAD_BYTES, accept: ACCEPTED_LOCAL_UPLOAD }
}
