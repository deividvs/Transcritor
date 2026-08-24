'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import JobCard from '@/components/job-card'
import {
  DEFAULT_CLOUD_MODEL,
  DEFAULT_OPTIONS,
  LANGUAGES,
  TERMINAL,
  modelsFor,
  type Job,
  type JobOptions,
} from '@/lib/types'

type Health = {
  ok: boolean
  mode: 'local' | 'cloud'
  hasCloudKey: boolean
  missing: { key: string; hint: string }[]
  upload: { maxBytes: number; accept: string }
}

const FIELD =
  'w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-zinc-200 outline-none transition focus:border-sky-500/50'

export default function Home() {
  const [url, setUrl] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [options, setOptions] = useState<JobOptions>(DEFAULT_OPTIONS)
  const [showOptions, setShowOptions] = useState(false)
  const [jobs, setJobs] = useState<Job[]>([])
  const [health, setHealth] = useState<Health | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sources = useRef(new Map<string, EventSource>())
  const fileInput = useRef<HTMLInputElement>(null)

  // Antes do /api/health responder assumimos local, que é o comportamento
  // histórico do app; a nuvem é o caso excepcional.
  const mode = health?.mode ?? 'local'
  const isCloud = mode === 'cloud'

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
    fetch('/api/health')
      .then((r) => r.json())
      .then((data: Health) => {
        setHealth(data)
        if (data.mode === 'cloud') {
          setOptions((prev) => ({ ...prev, model: DEFAULT_CLOUD_MODEL }))
        }
      })
      .catch(() => {})
    fetch('/api/jobs')
      .then((r) => r.json())
      .then((d) => setJobs(d.jobs ?? []))
      .catch(() => {})
  }, [])

  // Um EventSource por job em andamento; fecha sozinho ao terminar. No modo
  // nuvem o job já volta concluído, então nada é aberto.
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
      // Arquivo tem precedência: se o usuário escolheu um, é o que vale.
      // Vai no corpo cru (não multipart) para o servidor gravar por streaming.
      const res = file
        ? await fetch(
            `/api/jobs?filename=${encodeURIComponent(file.name)}&options=${encodeURIComponent(
              JSON.stringify(options),
            )}`,
            { method: 'POST', body: file },
          )
        : await fetch('/api/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, options }),
          })

      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? 'Não foi possível iniciar a transcrição.')

      upsert(data.job as Job)
      setUrl('')
      setFile(null)
      if (fileInput.current) fileInput.current.value = ''
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  // Re-transcreve reaproveitando o MP3 em disco. O job volta em 'transcribing',
  // então o efeito de SSE reabre o EventSource sozinho e o card mostra progresso.
  async function handleRetranscribe(id: string, patch: Partial<JobOptions>) {
    setError(null)
    try {
      const res = await fetch(`/api/jobs/${id}/retranscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ options: patch }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? 'Não foi possível re-transcrever.')
      upsert(data.job as Job)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
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

  // maxBytes 0 significa sem teto: no local o arquivo é gravado por streaming.
  const hasLimit = Boolean(health && health.upload.maxBytes > 0)
  const maxMb = health ? Math.round(health.upload.maxBytes / 1024 / 1024) : 4
  const canSubmit = Boolean(file) || url.trim().length > 0

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-10 sm:py-16">
      <header className="mb-8">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Transcritor</h1>
          <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-zinc-400">
            {isCloud ? 'nuvem · Groq' : 'local · MLX Whisper'}
          </span>
        </div>
        <p className="mt-1 text-sm text-zinc-500">
          {isCloud ? (
            <>
              Envie um arquivo de áudio ou vídeo (até {maxMb} MB) ou cole o link direto de uma
              mídia. A transcrição roda na API da Groq com o Whisper large-v3-turbo.
            </>
          ) : (
            <>
              Envie um vídeo ou áudio do seu computador (até {maxMb.toLocaleString('pt-BR')} MB), ou
              cole o link de um vídeo do YouTube ou Instagram. Converte para MP3 e transcreve — tudo
              localmente, sem enviar nada para a nuvem.
            </>
          )}
        </p>
      </header>

      {health && !health.ok && isCloud ? (
        <div className="mb-6 rounded-xl border border-amber-500/25 bg-amber-500/10 p-4 text-sm text-amber-200">
          <p className="font-medium">Falta a chave da Groq</p>
          <p className="mt-1 text-amber-200/80">
            Defina a variável de ambiente <code className="rounded bg-black/30 px-1">GROQ_API_KEY</code> no
            projeto. Sem ela a transcrição não roda neste ambiente.
          </p>
        </div>
      ) : null}

      {health && !health.ok && !isCloud ? (
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

      {isCloud ? (
        <p className="mb-4 rounded-xl border border-sky-500/20 bg-sky-500/5 px-4 py-3 text-xs leading-relaxed text-zinc-400">
          Links de <strong className="text-zinc-300">página</strong> do YouTube e do Instagram não
          funcionam aqui: extrair a mídia exige o <code className="text-zinc-300">yt-dlp</code>, que não roda
          em serverless. Para esses links, use o projeto na sua máquina — lá a transcrição também é
          offline e gratuita.
        </p>
      ) : null}

      <form onSubmit={handleSubmit} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="mb-2">
            <input
              ref={fileInput}
              type="file"
              accept={health?.upload.accept}
              onChange={(e) => {
                const chosen = e.target.files?.[0] ?? null
                setFile(chosen)
                if (chosen) setUrl('')
              }}
              className="w-full cursor-pointer rounded-lg border border-dashed border-white/15 bg-black/20 px-3 py-3 text-sm text-zinc-400 file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-sky-600/90 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-white hover:border-sky-500/40"
            />
            {file ? (
              <p className="mt-1.5 text-xs text-zinc-500">
                {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB
                {hasLimit && file.size > health!.upload.maxBytes ? (
                  <span className="text-amber-400"> — acima do limite de {maxMb} MB</span>
                ) : null}
              </p>
            ) : (
              <p className="mt-1.5 text-center text-xs text-zinc-600">
                {isCloud ? 'ou use um link direto abaixo' : 'ou cole um link abaixo'}
              </p>
            )}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={url}
            onChange={(e) => {
              setUrl(e.target.value)
              if (e.target.value) setFile(null)
            }}
            placeholder={
              isCloud ? 'https://exemplo.com/audio.mp3' : 'https://www.youtube.com/watch?v=…'
            }
            className={FIELD}
            autoComplete="off"
            spellCheck={false}
            disabled={Boolean(file)}
          />
          <button
            type="submit"
            disabled={submitting || !canSubmit}
            className="shrink-0 rounded-lg bg-sky-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? (isCloud ? 'Transcrevendo…' : 'Iniciando…') : 'Transcrever'}
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
                {modelsFor(mode).map((m) => (
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

            {/* Só fazem sentido no pipeline local (yt-dlp + ffmpeg). */}
            {!isCloud ? (
              <>
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
              </>
            ) : null}
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
          jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              onDelete={handleDelete}
              onRetranscribe={isCloud ? undefined : handleRetranscribe}
            />
          ))
        )}
      </section>
    </main>
  )
}
