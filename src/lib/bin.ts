import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * O Next roda com o PATH de quem iniciou o servidor, que muitas vezes não
 * inclui ~/.local/bin (onde o uv instala yt-dlp e mlx_whisper). Resolvemos os
 * binários na mão e injetamos um PATH completo em todo processo filho.
 */
const EXTRA_PATHS = [
  path.join(homedir(), '.local', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
]

export const RUN_PATH = [...EXTRA_PATHS, process.env.PATH ?? ''].filter(Boolean).join(':')

function resolveBin(name: string, envVar: string): string | null {
  const override = process.env[envVar]
  if (override && existsSync(override)) return override

  // Os caminhos vivem fora do projeto (~/.local/bin, /usr/bin…). Sem o ignore,
  // o tracer do Turbopack conclui que precisa empacotar o projeto inteiro.
  for (const dir of EXTRA_PATHS) {
    const candidate = path.join(/* turbopackIgnore: true */ dir, name)
    if (existsSync(/* turbopackIgnore: true */ candidate)) return candidate
  }

  try {
    const found = execFileSync('/usr/bin/which', [name], {
      env: { ...process.env, PATH: RUN_PATH },
      encoding: 'utf8',
    }).trim()
    if (found && existsSync(found)) return found
  } catch {
    /* not on PATH */
  }
  return null
}

export const BIN = {
  ytdlp: resolveBin('yt-dlp', 'YTDLP_PATH'),
  ffmpeg: resolveBin('ffmpeg', 'FFMPEG_PATH'),
  whisper: resolveBin('mlx_whisper', 'MLX_WHISPER_PATH'),
}

export const INSTALL_HINT: Record<string, string> = {
  ytdlp: 'uv tool install yt-dlp',
  ffmpeg: 'veja o README (binário estático em ~/.local/bin)',
  whisper: 'uv tool install mlx-whisper',
}

export function missingBins() {
  return (Object.keys(BIN) as (keyof typeof BIN)[]).filter((k) => !BIN[k])
}

export function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: RUN_PATH }
}

export function requireBin(key: keyof typeof BIN): string {
  const value = BIN[key]
  if (!value) {
    throw new Error(`Binário "${key}" não encontrado. Instale com: ${INSTALL_HINT[key]}`)
  }
  return value
}
