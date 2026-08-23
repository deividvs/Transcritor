import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'

export const DATA_DIR = path.join(process.cwd(), 'downloads')

export type { Stage, Segment, JobOptions, Job } from './types'
export { STAGE_LABEL, DEFAULT_OPTIONS } from './types'

import type { Job, JobOptions } from './types'

type Store = {
  jobs: Map<string, Job>
  emitters: Map<string, EventEmitter>
  loaded: boolean
}

// globalThis para sobreviver ao hot-reload do `next dev`
const g = globalThis as unknown as { __transcritor?: Store }
const store: Store = (g.__transcritor ??= {
  jobs: new Map(),
  emitters: new Map(),
  loaded: false,
})

export function jobDir(id: string) {
  return path.join(DATA_DIR, id)
}

export function emitterFor(id: string) {
  let emitter = store.emitters.get(id)
  if (!emitter) {
    emitter = new EventEmitter()
    emitter.setMaxListeners(100)
    store.emitters.set(id, emitter)
  }
  return emitter
}

function persist(job: Job) {
  try {
    fs.mkdirSync(jobDir(job.id), { recursive: true })
    fs.writeFileSync(path.join(jobDir(job.id), 'job.json'), JSON.stringify(job, null, 2))
  } catch {
    /* disco cheio ou permissão: não derruba o pipeline */
  }
}

/** Reidrata o histórico a partir do disco na primeira leitura após um restart. */
function loadFromDisk() {
  if (store.loaded) return
  store.loaded = true
  if (!fs.existsSync(DATA_DIR)) return

  for (const entry of fs.readdirSync(DATA_DIR)) {
    const file = path.join(DATA_DIR, entry, 'job.json')
    if (!fs.existsSync(file)) continue
    try {
      const job = JSON.parse(fs.readFileSync(file, 'utf8')) as Job
      if (store.jobs.has(job.id)) continue
      if (job.stage !== 'done' && job.stage !== 'error') {
        job.stage = 'error'
        job.message = 'Interrompido'
        job.error = 'O servidor foi reiniciado durante o processamento.'
      }
      store.jobs.set(job.id, job)
    } catch {
      /* job.json corrompido: ignora */
    }
  }
}

export function createJob(url: string, options: JobOptions): Job {
  const job: Job = {
    id: randomUUID().slice(0, 8),
    url,
    options,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    stage: 'queued',
    progress: 0,
    message: 'Na fila',
    files: {},
    segments: [],
    transcript: '',
  }
  loadFromDisk()
  store.jobs.set(job.id, job)
  persist(job)
  return job
}

export function getJob(id: string) {
  loadFromDisk()
  return store.jobs.get(id)
}

export function listJobs() {
  loadFromDisk()
  return [...store.jobs.values()].sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * `save` grava em disco. Só usamos em mudança de estágio / fim, porque o
 * progresso emite dezenas de updates por segundo.
 */
export function updateJob(id: string, patch: Partial<Job>, save = false) {
  const job = store.jobs.get(id)
  if (!job) return
  Object.assign(job, patch)
  job.updatedAt = Date.now()
  if (save) persist(job)
  emitterFor(id).emit('update', job)
}

export function deleteJob(id: string) {
  store.jobs.delete(id)
  store.emitters.delete(id)
  try {
    fs.rmSync(jobDir(id), { recursive: true, force: true })
  } catch {
    /* já removido */
  }
}
