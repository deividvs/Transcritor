'use client'

import { useState } from 'react'

import { formatDuration, formatRelative, formatTimestamp } from '@/lib/format'
import { STAGE_LABEL, type Job } from '@/lib/types'

const DOWNLOADS = [
  { kind: 'mp3', label: 'MP3' },
  { kind: 'txt', label: 'Texto' },
  { kind: 'srt', label: 'SRT' },
  { kind: 'vtt', label: 'VTT' },
  { kind: 'json', label: 'JSON' },
  { kind: 'video', label: 'Vídeo' },
]

function barColor(job: Job) {
  if (job.stage === 'error') return 'bg-red-500'
  if (job.stage === 'done') return 'bg-emerald-500'
  return 'bg-sky-500'
}

export default function JobCard({ job, onDelete }: { job: Job; onDelete: (id: string) => void }) {
  const [withTimes, setWithTimes] = useState(true)
  const [copied, setCopied] = useState(false)

  const running = job.stage !== 'done' && job.stage !== 'error'
  const available = DOWNLOADS.filter((d) => job.files[d.kind])

  async function copy() {
    const text = withTimes
      ? job.segments.map((s) => `[${formatTimestamp(s.start)}] ${s.text}`).join('\n')
      : job.transcript
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }

  return (
    <article className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
      <div className="flex gap-4 p-4">
        {job.thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={job.thumbnail}
            alt=""
            className="hidden h-20 w-32 shrink-0 rounded-lg object-cover sm:block"
          />
        ) : null}

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="truncate font-medium text-zinc-100">
                {job.title ?? job.url}
              </h3>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
                {job.uploader ? <span className="truncate">{job.uploader}</span> : null}
                {job.duration ? <span>· {formatDuration(job.duration)}</span> : null}
                {job.extractor ? <span>· {job.extractor}</span> : null}
                <span>· {formatRelative(job.createdAt)}</span>
              </p>
            </div>
            <button
              onClick={() => onDelete(job.id)}
              className="shrink-0 rounded-md px-2 py-1 text-xs text-zinc-500 transition hover:bg-white/5 hover:text-red-400"
              title="Remover job e arquivos"
            >
              remover
            </button>
          </div>

          <div className="mt-3">
            <div className="mb-1.5 flex items-baseline justify-between gap-3 text-xs">
              <span className={job.stage === 'error' ? 'text-red-400' : 'text-zinc-400'}>
                {job.stage === 'done' ? 'Concluído' : job.message || STAGE_LABEL[job.stage]}
              </span>
              {running ? <span className="tabular-nums text-zinc-500">{Math.round(job.progress)}%</span> : null}
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
              <div
                className={`h-full rounded-full transition-[width] duration-300 ${barColor(job)}`}
                style={{ width: `${job.stage === 'error' ? 100 : job.progress}%` }}
              />
            </div>
          </div>

          {job.error ? (
            <p className="mt-3 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {job.error}
            </p>
          ) : null}

          {available.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {available.map((d) => (
                <a
                  key={d.kind}
                  href={`/api/jobs/${job.id}/file?kind=${d.kind}`}
                  className="rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-zinc-300 transition hover:border-sky-500/40 hover:text-sky-300"
                >
                  ↓ {d.label}
                </a>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {job.segments.length > 0 || job.transcript ? (
        <div className="border-t border-white/10 bg-black/20">
          <div className="flex items-center justify-between gap-3 px-4 py-2">
            <div className="flex items-center gap-3 text-xs text-zinc-500">
              <span>{job.segments.length} trechos</span>
              {job.detectedLanguage ? <span>· {job.detectedLanguage}</span> : null}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setWithTimes((v) => !v)}
                className="rounded-md px-2 py-1 text-xs text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200"
              >
                {withTimes ? 'texto corrido' : 'com tempos'}
              </button>
              <button
                onClick={copy}
                className="rounded-md border border-white/10 px-2 py-1 text-xs text-zinc-300 transition hover:bg-white/5"
              >
                {copied ? 'copiado ✓' : 'copiar'}
              </button>
            </div>
          </div>

          <div className="max-h-80 overflow-y-auto px-4 pb-4 text-sm leading-relaxed">
            {withTimes ? (
              <ul className="space-y-1">
                {job.segments.map((s, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="shrink-0 pt-0.5 font-mono text-[11px] tabular-nums text-zinc-600">
                      {formatTimestamp(s.start)}
                    </span>
                    <span className="text-zinc-300">{s.text}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="whitespace-pre-wrap text-zinc-300">{job.transcript}</p>
            )}
          </div>
        </div>
      ) : null}
    </article>
  )
}
