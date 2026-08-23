'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import JobCard from '@/components/job-card'
import {
  DEFAULT_OPTIONS,
  LANGUAGES,
  MODELS,
  TERMINAL,
  type Job,
  type JobOptions,
} from '@/lib/types'

type Health = { ok: boolean; missing: { key: string; hint: string }[] }

const FIELD =
  'w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-zinc-200 outline-none transition focus:border-sky-500/50'

export default function Home() {
  const [url, setUrl] = useState('')
  const [options, setOptions] = useState<JobOptions>(DEFAULT_OPTIONS)
  const [showOptions, setShowOptions] = useState(false)
  const [jobs, setJobs] = useState<Job[]>([])
  const [health, setHealth] = useState<Health | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sources = useRef(new Map<string, EventSource>())

  const upsert = useCallback((incoming: Job) => {
    setJobs((prev) => {
      const index = prev.findIndex((j) => j.id === incoming.id)
      if (index === -1) return [incoming, ...prev]
      const next = [...prev]
      next[index] = incoming
      return next
    })
  }, [])

  useEffect(() => {
    fetch('/api/health').then((r) => r.json()).then(setHealth).catch(() => {})
    fetch('/api/jobs')
      .then((r) => r.json())
      .then((d) => setJobs(d.jobs ?? []))
      .catch(() => {})
  }, [])

  // Um EventSource por job em andamento; fecha sozinho ao terminar.
  useEffect(() => {
    const live = sources.current

    for (const job of jobs) {
      if (TERMINAL.includes(job.stage) || live.has(job.id)) continue

      const es = new EventSource(`/api/jobs/${job.id}/events`)
      live.set(job.id, es)

      es.onmessage = (event) => {
        const updated = JSON.parse(event.data) as Job
        upsert(updated)
        if (TERMINAL.includes(updated.stage)) {
          es.close()
          live.delete(updated.id)
        }
      }
      es.onerror = () => {
        es.close()
        live.delete(job.id)
      }
    }

    for (const [id, es] of live) {
      if (!jobs.some((j) => j.id === id)) {
        es.close()
        live.delete(id)
      }
    }
  }, [jobs, upsert])

  useEffect(() => {
    const live = sources.current
    return () => {
      for (const es of live.values()) es.close()
      live.clear()
    }
  }, [])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, options }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Não foi possível iniciar o job.')
      upsert(data.job as Job)
      setUrl('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(id: string) {
    sources.current.get(id)?.close()
    sources.current.delete(id)
    setJobs((prev) => prev.filter((j) => j.id !== id))
    await fetch(`/api/jobs/${id}`, { method: 'DELETE' }).catch(() => {})
  }

  const set = <K extends keyof JobOptions>(key: K, value: JobOptions[K]) =>
    setOptions((prev) => ({ ...prev, [key]: value }))

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-10 sm:py-16">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Transcritor</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Cole o link de um vídeo do YouTube ou Instagram. Baixa o áudio, converte para MP3 e
          transcreve — tudo localmente, sem enviar nada para a nuvem.
        </p>
      </header>

      {health && !health.ok ? (
        <div className="mb-6 rounded-xl border border-amber-500/25 bg-amber-500/10 p-4 text-sm text-amber-200">
          <p className="font-medium">Dependências faltando</p>
          <ul className="mt-2 space-y-1 text-amber-200/80">
            {health.missing.map((m) => (
              <li key={m.key}>
                <code className="text-amber-100">{m.key}</code> — instale com{' '}
                <code className="rounded bg-black/30 px-1">{m.hint}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <form onSubmit={handleSubmit} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=…"
            className={FIELD}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="submit"
            disabled={submitting || !url.trim()}
            className="shrink-0 rounded-lg bg-sky-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? 'Iniciando…' : 'Transcrever'}
          </button>
        </div>

        <button
          type="button"
          onClick={() => setShowOptions((v) => !v)}
          className="mt-3 text-xs text-zinc-500 transition hover:text-zinc-300"
        >
          {showOptions ? '▾' : '▸'} opções
        </button>

        {showOptions ? (
          <div className="mt-3 grid gap-3 border-t border-white/10 pt-3 sm:grid-cols-2">
            <label className="text-xs text-zinc-500">
              Modelo
              <select
                value={options.model}
                onChange={(e) => set('model', e.target.value)}
                className={`${FIELD} mt-1`}
              >
                {MODELS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-xs text-zinc-500">
              Idioma
              <select
                value={options.language}
                onChange={(e) => set('language', e.target.value)}
                className={`${FIELD} mt-1`}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-xs text-zinc-500">
              Qualidade do MP3
              <select
                value={options.audioQuality}
                onChange={(e) => set('audioQuality', e.target.value as JobOptions['audioQuality'])}
                className={`${FIELD} mt-1`}
              >
                <option value="voz">Voz — 64 kbps mono (arquivo pequeno)</option>
                <option value="alta">Alta — 192 kbps estéreo</option>
              </select>
            </label>

            <label className="text-xs text-zinc-500">
              Navegador para cookies
              <select
                value={options.browser}
                onChange={(e) => set('browser', e.target.value)}
                disabled={!options.useCookies}
                className={`${FIELD} mt-1 disabled:opacity-40`}
              >
                {['chrome', 'safari', 'firefox', 'edge', 'brave'].map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-2 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={options.keepVideo}
                onChange={(e) => set('keepVideo', e.target.checked)}
                className="accent-sky-500"
              />
              guardar também o vídeo (MP4)
            </label>

            <label className="flex items-center gap-2 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={options.useCookies}
                onChange={(e) => set('useCookies', e.target.checked)}
                className="accent-sky-500"
              />
              usar cookies do navegador (conteúdo restrito)
            </label>
          </div>
        ) : null}

        {error ? (
          <p className="mt-3 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        ) : null}
      </form>

      <section className="mt-6 space-y-3">
        {jobs.length === 0 ? (
          <p className="py-10 text-center text-sm text-zinc-600">Nenhuma transcrição ainda.</p>
        ) : (
          jobs.map((job) => <JobCard key={job.id} job={job} onDelete={handleDelete} />)
        )}
      </section>
    </main>
  )
}
