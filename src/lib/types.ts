export type Stage =
  | 'queued'
  | 'metadata'
  | 'downloading'
  | 'converting'
  | 'transcribing'
  | 'done'
  | 'error'

export const STAGE_LABEL: Record<Stage, string> = {
  queued: 'Na fila',
  metadata: 'Lendo o link',
  downloading: 'Baixando',
  converting: 'Convertendo para MP3',
  transcribing: 'Transcrevendo',
  done: 'Concluído',
  error: 'Erro',
}

export const TERMINAL: Stage[] = ['done', 'error']

export type Segment = { start: number; end: number; text: string }

export type JobOptions = {
  keepVideo: boolean
  audioQuality: 'voz' | 'alta'
  model: string
  language: string
  useCookies: boolean
  browser: string
}

export const DEFAULT_OPTIONS: JobOptions = {
  keepVideo: false,
  audioQuality: 'voz',
  model: 'mlx-community/whisper-large-v3-turbo',
  language: 'pt',
  useCookies: false,
  browser: 'chrome',
}

export const MODELS = [
  { value: 'mlx-community/whisper-large-v3-turbo', label: 'Large v3 Turbo — melhor qualidade (~1.5 GB)' },
  { value: 'mlx-community/whisper-medium-mlx', label: 'Medium — equilibrado (~1.5 GB)' },
  { value: 'mlx-community/whisper-small-mlx', label: 'Small — rápido (~470 MB)' },
  { value: 'mlx-community/whisper-tiny-mlx', label: 'Tiny — teste rápido (~75 MB)' },
]

/** Modelos da Groq, usados quando não há stack local (modo nuvem). */
export const CLOUD_MODELS = [
  { value: 'whisper-large-v3-turbo', label: 'Large v3 Turbo — rápido e barato ($0,04/h)' },
  { value: 'whisper-large-v3', label: 'Large v3 — mais preciso ($0,111/h)' },
]

export const DEFAULT_CLOUD_MODEL = CLOUD_MODELS[0].value

export function modelsFor(mode: 'local' | 'cloud') {
  return mode === 'cloud' ? CLOUD_MODELS : MODELS
}

export const LANGUAGES = [
  { value: 'pt', label: 'Português' },
  { value: '', label: 'Detectar automaticamente' },
  { value: 'en', label: 'Inglês' },
  { value: 'es', label: 'Espanhol' },
  { value: 'fr', label: 'Francês' },
  { value: 'de', label: 'Alemão' },
  { value: 'it', label: 'Italiano' },
]

export type Job = {
  id: string
  url: string
  options: JobOptions
  createdAt: number
  updatedAt: number
  stage: Stage
  progress: number
  message: string
  title?: string
  uploader?: string
  duration?: number
  thumbnail?: string
  extractor?: string
  /** Onde a transcrição rodou. Ausente em jobs antigos, gravados antes do modo nuvem. */
  mode?: 'local' | 'cloud'
  detectedLanguage?: string
  files: Record<string, string>
  segments: Segment[]
  transcript: string
  error?: string
}
