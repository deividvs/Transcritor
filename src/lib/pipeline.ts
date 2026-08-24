import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { childEnv, requireBin } from './bin'
import { type Job, type Segment, jobDir, updateJob } from './jobs'
import { toSrt, toVtt } from './subtitles'

type LineHandler = (line: string) => void

type RunOptions = {
  onLine?: LineHandler
  collectStdout?: boolean
}

/** Spawn com quebra de linha por \n e \r (barras de progresso usam \r). */
function run(cmd: string, args: string[], opts: RunOptions = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(cmd, args, { env: childEnv() })
    let stdout = ''
    let stderr = ''
    const buffers = { out: '', err: '' }

    const feed = (key: 'out' | 'err', chunk: string) => {
      buffers[key] += chunk
      const parts = buffers[key].split(/\r\n|\r|\n/)
      buffers[key] = parts.pop() ?? ''
      for (const line of parts) if (line.trim()) opts.onLine?.(line)
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      if (opts.collectStdout) stdout += d
      feed('out', d)
    })
    child.stderr.on('data', (d: string) => {
      stderr += d
      feed('err', d)
    })

    child.on('error', reject)
    child.on('close', (code) => {
      // descarrega o que sobrou sem quebra de linha
      for (const key of ['out', 'err'] as const) {
        if (buffers[key].trim()) opts.onLine?.(buffers[key])
      }
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n))

/** Pesos de cada etapa na barra de progresso global. */
const SPAN = { metadata: [0, 5], download: [5, 40], convert: [40, 50], transcribe: [50, 100] }

/**
 * Arquivo enviado pelo usuário já chega em disco: não há metadata nem download,
 * então a conversão e a transcrição se esticam para ocupar a barra inteira.
 */
const FILE_SPAN = { convert: [0, 15], transcribe: [15, 100] }

type Spans = { convert: number[]; transcribe: number[] }

/**
 * Áudio longo derruba o mlx_whisper numa máquina de 8 GB: ele carrega o áudio
 * inteiro e, num arquivo de horas, o processo morre sem escrever nada. Acima do
 * limiar transcrevemos em fatias e costuramos o resultado, deslocando os tempos.
 */
const CHUNK_THRESHOLD_SECONDS = 30 * 60
const CHUNK_SECONDS = 10 * 60

function scale(span: number[], pct: number) {
  return clamp(span[0] + (pct / 100) * (span[1] - span[0]))
}

function cookieArgs(job: Job) {
  return job.options.useCookies ? ['--cookies-from-browser', job.options.browser] : []
}

/** "01:02:03.450" | "02:03.450" -> segundos */
function parseTimestamp(value: string) {
  return value.split(':').reduce((acc, part) => acc * 60 + parseFloat(part), 0)
}

/**
 * Alguns extratores (Instagram, por exemplo) não informam a duração. Sem ela o
 * progresso de conversão e transcrição não tem denominador. O build estático do
 * ffmpeg não traz ffprobe, mas abrir o arquivo já imprime "Duration:" no stderr
 * — o ffmpeg sai com erro por falta de output, e isso não é problema aqui.
 */
async function probeDuration(file: string) {
  let seconds: number | undefined

  await run(requireBin('ffmpeg'), ['-hide_banner', '-nostdin', '-i', file], {
    onLine: (line) => {
      const match = line.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/)
      if (!match) return
      seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + parseFloat(match[3])
    },
  })

  return seconds && Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
}

async function stepMetadata(job: Job) {
  const ytdlp = requireBin('ytdlp')
  updateJob(job.id, { stage: 'metadata', progress: 2, message: 'Lendo informações do link…' }, true)

  const { code, stdout } = await run(
    ytdlp,
    ['--dump-single-json', '--no-playlist', '--no-warnings', ...cookieArgs(job), job.url],
    { collectStdout: true },
  )

  if (code !== 0 || !stdout.trim()) {
    throw new Error(
      'Não consegui ler esse link. Confira se a URL está correta e se o conteúdo é público. ' +
        'Para conteúdo restrito, marque "usar cookies do navegador".',
    )
  }

  const data = JSON.parse(stdout) as Record<string, unknown>
  updateJob(
    job.id,
    {
      title: (data.title as string) ?? 'Sem título',
      uploader: (data.uploader as string) ?? (data.channel as string) ?? (data.uploader_id as string),
      duration: typeof data.duration === 'number' ? data.duration : undefined,
      thumbnail: data.thumbnail as string | undefined,
      extractor: data.extractor_key as string | undefined,
      progress: SPAN.metadata[1],
    },
    true,
  )
}

async function stepDownload(job: Job) {
  const ytdlp = requireBin('ytdlp')
  const ffmpeg = requireBin('ffmpeg')
  const dir = jobDir(job.id)
  const keepVideo = job.options.keepVideo

  updateJob(job.id, {
    stage: 'downloading',
    progress: SPAN.download[0],
    message: keepVideo ? 'Baixando vídeo…' : 'Baixando áudio…',
  }, true)

  const args = [
    '-f', keepVideo ? 'bv*+ba/b' : 'ba/b',
    '--no-playlist',
    '--newline',
    '--no-warnings',
    '--retries', '5',
    '--fragment-retries', '10',
    '--ffmpeg-location', path.dirname(ffmpeg),
    '-o', path.join(dir, 'source.%(ext)s'),
    ...cookieArgs(job),
  ]
  if (keepVideo) args.push('--merge-output-format', 'mp4')
  args.push(job.url)

  const { code } = await run(ytdlp, args, {
    onLine: (line) => {
      const match = line.match(/\[download\]\s+([\d.]+)%/)
      if (!match) return
      const pct = parseFloat(match[1])
      updateJob(job.id, {
        progress: scale(SPAN.download, pct),
        message: `Baixando… ${pct.toFixed(0)}%`,
      })
    },
  })

  if (code !== 0) {
    throw new Error(
      'Falha no download. O conteúdo pode ser privado, ter sido removido ou exigir login ' +
        '(tente marcar "usar cookies do navegador").',
    )
  }

  const downloaded = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('source.') && !f.endsWith('.part'))
    .map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0]

  if (!downloaded) throw new Error('O download terminou mas nenhum arquivo foi gerado.')

  if (keepVideo) {
    updateJob(job.id, { files: { ...job.files, video: path.basename(downloaded) } }, true)
  }
  return downloaded
}

async function stepConvert(job: Job, input: string, spans: Spans = SPAN) {
  const ffmpeg = requireBin('ffmpeg')
  const output = path.join(jobDir(job.id), 'audio.mp3')
  const total = job.duration ?? 0

  const quality =
    job.options.audioQuality === 'alta'
      ? ['-ac', '2', '-ar', '44100', '-b:a', '192k']
      : ['-ac', '1', '-ar', '22050', '-b:a', '64k']

  updateJob(job.id, {
    stage: 'converting',
    progress: spans.convert[0],
    message: 'Convertendo para MP3…',
  }, true)

  const { code } = await run(
    ffmpeg,
    [
      '-hide_banner', '-nostdin', '-y',
      '-i', input,
      '-vn', '-c:a', 'libmp3lame', ...quality,
      '-progress', 'pipe:1', '-nostats',
      output,
    ],
    {
      onLine: (line) => {
        const match = line.match(/^out_time_us=(\d+)/)
        if (!match || total <= 0) return
        const pct = clamp((Number(match[1]) / 1e6 / total) * 100)
        updateJob(job.id, {
          progress: scale(spans.convert, pct),
          message: `Convertendo para MP3… ${pct.toFixed(0)}%`,
        })
      },
    },
  )

  if (code !== 0) throw new Error('O ffmpeg falhou ao converter o áudio para MP3.')

  updateJob(job.id, {
    progress: spans.convert[1],
    files: { ...job.files, mp3: 'audio.mp3' },
  }, true)

  return output
}

const EMPTY_RESULT =
  'A transcrição terminou sem gerar texto. Com áudio longo isso normalmente é falta de ' +
  'memória: tente de novo com um modelo menor (Small ou Tiny) nas opções.'

/**
 * Roda o mlx_whisper num arquivo. Os segmentos saem do stdout (`--verbose`), que
 * também alimenta o progresso. `offset` desloca os tempos quando o arquivo é uma
 * fatia de um áudio maior.
 */
async function whisperOn(
  job: Job,
  file: string,
  outDir: string,
  outName: string,
  offset: number,
  onSegment: (segment: Segment) => void,
  onMessage: (text: string) => void,
) {
  const whisper = requireBin('whisper')

  const args = [
    file,
    '--model', job.options.model,
    '--output-dir', outDir,
    '--output-name', outName,
    '--output-format', 'all',
    '--verbose', 'True',
  ]
  if (job.options.language) args.push('--language', job.options.language)

  const { code } = await run(whisper, args, {
    onLine: (line) => {
      // O mlx_whisper sempre roda essa etapa: baixa os pesos na primeira vez,
      // e só confere o cache do HuggingFace nas seguintes.
      const fetching = line.match(/Fetching \d+ files:\s+(\d+)%/)
      if (fetching) {
        onMessage(`Preparando o modelo Whisper… ${fetching[1]}%`)
        return
      }

      const detected = line.match(/Detected language:\s*(.+)/i)
      if (detected) {
        updateJob(job.id, { detectedLanguage: detected[1].trim() })
        return
      }

      const seg = line.match(/^\[([\d:.]+)\s*-->\s*([\d:.]+)\]\s*(.*)$/)
      if (!seg) return

      onSegment({
        start: parseTimestamp(seg[1]) + offset,
        end: parseTimestamp(seg[2]) + offset,
        text: seg[3].trim(),
      })
    },
  })

  return code
}

/** Corta o MP3 em pedaços sem recodificar (`-c copy`), então é quase instantâneo. */
async function splitAudio(mp3: string, dir: string) {
  fs.mkdirSync(dir, { recursive: true })

  const { code } = await run(requireBin('ffmpeg'), [
    '-hide_banner', '-nostdin', '-y',
    '-i', mp3,
    '-f', 'segment',
    '-segment_time', String(CHUNK_SECONDS),
    '-c', 'copy',
    path.join(dir, 'parte_%03d.mp3'),
  ])

  if (code !== 0) throw new Error('Não consegui fatiar o áudio para transcrever por partes.')

  const parts = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('parte_') && f.endsWith('.mp3'))
    .sort()
    .map((f) => path.join(dir, f))

  if (parts.length === 0) throw new Error('O fatiamento do áudio não gerou nenhuma parte.')
  return parts
}

/**
 * No modo fatiado somos nós que escrevemos os artefatos, porque cada parte gera
 * os seus e eles precisam ser costurados com os tempos já deslocados.
 */
function writeArtifacts(job: Job, segments: Segment[]) {
  const dir = jobDir(job.id)
  const transcript = segments.map((s) => s.text).join(' ').trim()

  fs.writeFileSync(path.join(dir, 'audio.txt'), `${transcript}\n`)
  fs.writeFileSync(path.join(dir, 'audio.srt'), toSrt(segments))
  fs.writeFileSync(path.join(dir, 'audio.vtt'), toVtt(segments))
  fs.writeFileSync(
    path.join(dir, 'audio.json'),
    JSON.stringify({ text: transcript, duration: job.duration, segments }, null, 2),
  )

  const files = { ...job.files }
  for (const ext of ['txt', 'srt', 'vtt', 'json']) files[ext] = `audio.${ext}`

  updateJob(job.id, { files, transcript, segments }, true)
}

async function transcribeWhole(job: Job, mp3: string, spans: Spans, total: number) {
  const dir = jobDir(job.id)
  const segments: Segment[] = []

  updateJob(job.id, {
    stage: 'transcribing',
    progress: spans.transcribe[0],
    message: 'Carregando o modelo Whisper…',
  }, true)

  const code = await whisperOn(job, mp3, dir, 'audio', 0,
    (segment) => {
      segments.push(segment)
      const pct = total > 0 ? clamp((segment.end / total) * 100) : Math.min(95, segments.length * 2)
      updateJob(job.id, {
        segments: [...segments],
        transcript: segments.map((s) => s.text).join(' '),
        progress: scale(spans.transcribe, pct),
        message: `Transcrevendo… ${pct.toFixed(0)}%`,
      })
    },
    (text) => updateJob(job.id, { message: text }),
  )

  if (code !== 0) throw new Error('A transcrição falhou. Veja o terminal do servidor para detalhes.')

  const files = { ...job.files }
  for (const ext of ['txt', 'srt', 'vtt', 'json', 'tsv']) {
    if (fs.existsSync(path.join(dir, `audio.${ext}`))) files[ext] = `audio.${ext}`
  }

  const txtPath = path.join(dir, 'audio.txt')
  const transcript = fs.existsSync(txtPath)
    ? fs.readFileSync(txtPath, 'utf8').trim()
    : segments.map((s) => s.text).join(' ').trim()

  // Sair com código 0 mas sem nada escrito acontece quando o processo é morto
  // por memória. Antes isso virava um job "Concluído" e vazio.
  if (!transcript && segments.length === 0) throw new Error(EMPTY_RESULT)

  updateJob(job.id, { files, transcript }, true)
}

async function transcribeChunked(job: Job, mp3: string, spans: Spans, total: number) {
  const chunkDir = path.join(jobDir(job.id), 'partes')

  updateJob(job.id, {
    stage: 'transcribing',
    progress: spans.transcribe[0],
    message: 'Preparando o áudio em partes…',
  }, true)

  const parts = await splitAudio(mp3, chunkDir)
  const all: Segment[] = []

  for (const [index, part] of parts.entries()) {
    const code = await whisperOn(job, part, chunkDir, `parte_${index}`, index * CHUNK_SECONDS,
      (segment) => {
        all.push(segment)
        const pct = total > 0 ? clamp((segment.end / total) * 100) : 0
        updateJob(job.id, {
          segments: [...all],
          transcript: all.map((s) => s.text).join(' '),
          progress: scale(spans.transcribe, pct),
          message: `Transcrevendo parte ${index + 1} de ${parts.length}… ${pct.toFixed(0)}%`,
        })
      },
      (text) => updateJob(job.id, { message: `${text} (parte ${index + 1}/${parts.length})` }),
    )

    if (code !== 0) {
      throw new Error(`A transcrição falhou na parte ${index + 1} de ${parts.length}. ${EMPTY_RESULT}`)
    }
  }

  if (all.length === 0) throw new Error(EMPTY_RESULT)

  writeArtifacts(job, all)
  try { fs.rmSync(chunkDir, { recursive: true, force: true }) } catch { /* ignore */ }
}

/**
 * Áudio curto vai inteiro; áudio longo vai fatiado, porque numa máquina de 8 GB
 * o mlx_whisper morre em arquivos de horas.
 */
async function stepTranscribe(job: Job, mp3: string, spans: Spans = SPAN) {
  const total = job.duration ?? 0
  return total > CHUNK_THRESHOLD_SECONDS
    ? transcribeChunked(job, mp3, spans, total)
    : transcribeWhole(job, mp3, spans, total)
}

export async function runPipeline(job: Job) {
  try {
    fs.mkdirSync(jobDir(job.id), { recursive: true })

    await stepMetadata(job)
    const media = await stepDownload(job)

    // Precisa vir antes da conversão: as duas etapas seguintes usam a duração
    // como denominador do progresso.
    if (!job.duration) {
      const probed = await probeDuration(media)
      if (probed) updateJob(job.id, { duration: probed }, true)
    }

    const mp3 = await stepConvert(job, media)

    // O arquivo bruto só interessa se o usuário pediu para guardar o vídeo.
    if (!job.options.keepVideo) {
      try { fs.rmSync(media, { force: true }) } catch { /* ignore */ }
    }

    await stepTranscribe(job, mp3)

    updateJob(job.id, { stage: 'done', progress: 100, message: 'Concluído' }, true)
  } catch (error) {
    updateJob(job.id, {
      stage: 'error',
      message: 'Falhou',
      error: error instanceof Error ? error.message : String(error),
    }, true)
  }
}

/**
 * Variante para arquivo enviado pelo usuário: a mídia já está em disco, então
 * pulamos metadata e download e vamos direto para conversão e transcrição.
 */
export async function runPipelineFromFile(job: Job, media: string) {
  try {
    if (!job.duration) {
      const probed = await probeDuration(media)
      if (probed) updateJob(job.id, { duration: probed }, true)
    }

    const mp3 = await stepConvert(job, media, FILE_SPAN)

    // O original só fica se o usuário pediu para guardar o vídeo; senão vira
    // cópia duplicada do que ele já tem na máquina. Quem registra `files.video`
    // é a rota de upload, e só quando keepVideo está ligado.
    if (!job.options.keepVideo) {
      try { fs.rmSync(media, { force: true }) } catch { /* ignore */ }
    }

    await stepTranscribe(job, mp3, FILE_SPAN)

    updateJob(job.id, { stage: 'done', progress: 100, message: 'Concluído' }, true)
  } catch (error) {
    updateJob(job.id, {
      stage: 'error',
      message: 'Falhou',
      error: error instanceof Error ? error.message : String(error),
    }, true)
  }
}

/**
 * Re-transcreve um job concluído reaproveitando o `audio.mp3` que já está em
 * disco. Serve para corrigir o idioma ou trocar o modelo sem baixar nem
 * converter de novo — a etapa cara é só a transcrição, que ocupa a barra toda.
 */
export async function runRetranscribe(job: Job, mp3: string) {
  try {
    await stepTranscribe(job, mp3, { convert: [0, 0], transcribe: [0, 100] })
    updateJob(job.id, { stage: 'done', progress: 100, message: 'Concluído' }, true)
  } catch (error) {
    updateJob(job.id, {
      stage: 'error',
      message: 'Falhou',
      error: error instanceof Error ? error.message : String(error),
    }, true)
  }
}
