import type { Job, Segment } from './types'

/**
 * No modo local o mlx_whisper grava txt/srt/vtt/json em disco e o download vem
 * da API. No modo nuvem não há disco, então os mesmos formatos são montados no
 * navegador a partir dos segmentos que a Groq devolveu.
 */

function stamp(seconds: number, comma: boolean) {
  const total = Math.max(0, seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = Math.floor(total % 60)
  const ms = Math.round((total - Math.floor(total)) * 1000)
  const pad = (n: number, size = 2) => String(n).padStart(size, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}${comma ? ',' : '.'}${pad(ms, 3)}`
}

export function toSrt(segments: Segment[]) {
  return segments
    .map((s, i) => `${i + 1}\n${stamp(s.start, true)} --> ${stamp(s.end, true)}\n${s.text}\n`)
    .join('\n')
}

export function toVtt(segments: Segment[]) {
  const body = segments
    .map((s) => `${stamp(s.start, false)} --> ${stamp(s.end, false)}\n${s.text}\n`)
    .join('\n')
  return `WEBVTT\n\n${body}`
}

export type BuiltFile = { mime: string; ext: string; content: string }

export function buildFile(job: Job, kind: string): BuiltFile | null {
  switch (kind) {
    case 'txt':
      return { mime: 'text/plain;charset=utf-8', ext: 'txt', content: job.transcript }
    case 'srt':
      return { mime: 'application/x-subrip;charset=utf-8', ext: 'srt', content: toSrt(job.segments) }
    case 'vtt':
      return { mime: 'text/vtt;charset=utf-8', ext: 'vtt', content: toVtt(job.segments) }
    case 'json':
      return {
        mime: 'application/json;charset=utf-8',
        ext: 'json',
        content: JSON.stringify(
          { title: job.title, duration: job.duration, language: job.detectedLanguage, segments: job.segments },
          null,
          2,
        ),
      }
    default:
      return null
  }
}

export function slug(value: string) {
  return (
    value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'transcricao'
  )
}
