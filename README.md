# Transcritor

App web que recebe o link de um vídeo do **YouTube** ou **Instagram**, baixa a mídia,
converte o áudio para **MP3** e gera a **transcrição em texto** — tudo na sua máquina.
Nenhum áudio sai do computador e não há custo por transcrição.

Publicado numa URL (serverless), o app cai automaticamente no **modo nuvem**: transcreve pela
API da Groq, aceita upload de arquivo ou link direto de mídia, e não aceita link de *página* do
YouTube/Instagram. Veja [Dois modos](#dois-modos).

```
link  →  yt-dlp  →  ffmpeg (MP3)  →  mlx-whisper (Metal/GPU)  →  txt · srt · vtt · json
```

## Requisitos

| Ferramenta | Para quê | Instalação |
|---|---|---|
| Node 20+ | rodar o app | já instalado |
| `yt-dlp` | baixar do YouTube/Instagram | `uv tool install yt-dlp` |
| `ffmpeg` | converter para MP3 | veja abaixo |
| `mlx_whisper` | transcrever (Apple Silicon) | `uv tool install mlx-whisper` |

O app procura os binários em `~/.local/bin`, `/opt/homebrew/bin` e `/usr/local/bin`, nessa ordem.
Se algum faltar, a página avisa logo no topo com o comando de instalação.

### ffmpeg sem Homebrew

```bash
FF=$(uv run --with imageio-ffmpeg python -c "import imageio_ffmpeg as f; print(f.get_ffmpeg_exe())")
cp "$FF" ~/.local/bin/ffmpeg && chmod +x ~/.local/bin/ffmpeg
```

### Caminhos customizados

Se preferir apontar os binários na mão, crie um `.env.local`:

```
YTDLP_PATH=/caminho/para/yt-dlp
FFMPEG_PATH=/caminho/para/ffmpeg
MLX_WHISPER_PATH=/caminho/para/mlx_whisper
```

## Uso

```bash
npm run dev     # http://localhost:3000
```

Cole a URL, clique em **Transcrever** e acompanhe o progresso ao vivo. A transcrição aparece
trecho a trecho conforme o Whisper avança. Ao terminar você baixa MP3, TXT, SRT, VTT e JSON.

### Opções

| Opção | Padrão | Observação |
|---|---|---|
| Modelo | `whisper-large-v3-turbo` | Baixa ~1,5 GB **na primeira vez** e fica em cache. `small` ou `tiny` são bem mais rápidos e leves. |
| Idioma | Português | "Detectar automaticamente" custa alguns segundos a mais. Fixar o idioma melhora a precisão. |
| Qualidade do MP3 | Voz (64 kbps mono) | Suficiente para fala e gera arquivo pequeno. Use "Alta" se quiser ouvir música. |
| Guardar o vídeo | desligado | Ligado, baixa e mantém o MP4 além do MP3. Desligado, baixa só a faixa de áudio (bem mais rápido). |
| Cookies do navegador | desligado | Necessário para conteúdo restrito/privado do Instagram. Usa `yt-dlp --cookies-from-browser`. No macOS o Chrome pede permissão de acesso ao Keychain. |

## Onde ficam os arquivos

```
downloads/<job-id>/
  job.json     metadados do job (o histórico é reconstruído daqui após um restart)
  audio.mp3    áudio convertido
  audio.txt    transcrição corrida
  audio.srt    legenda
  audio.vtt    legenda (web)
  audio.json   segmentos com timestamps
  source.mp4   só existe se "guardar o vídeo" estiver ligado
```

`downloads/` está no `.gitignore`. Remover um job pela interface apaga a pasta inteira.

## Como funciona

- **`src/lib/bin.ts`** — resolve os binários. O Next herda o `PATH` de quem iniciou o servidor,
  que muitas vezes não inclui `~/.local/bin`; por isso injetamos um `PATH` completo em todo
  processo filho.
- **`src/lib/jobs.ts`** — store em memória (num `globalThis`, para sobreviver ao hot-reload) com
  espelho em disco no `job.json`. Cada job tem um `EventEmitter` próprio.
- **`src/lib/pipeline.ts`** — as quatro etapas. O progresso de cada uma é extraído do stdout dos
  processos: `[download] 42.1%` do yt-dlp, `out_time_us=` do ffmpeg (via `-progress pipe:1`) e as
  linhas `[00:12.480 --> 00:15.200]` do mlx-whisper.
- **`/api/jobs/[id]/events`** — SSE. O cliente abre um `EventSource` por job em andamento e o
  servidor fecha o stream sozinho quando o job termina.

## Áudio longo

Acima de 30 minutos o áudio é cortado em partes de 10 minutos e transcrito pedaço por pedaço, com
os tempos costurados no fim. Isso existe porque numa máquina de 8 GB o Whisper morre tentando
carregar um arquivo de várias horas de uma vez.

Se ainda assim faltar memória, o app avisa e sugere trocar para um modelo menor — ele **não**
finge que deu certo.

## Re-transcrever

Todo job concluído guarda o MP3. No card dele há **↻ re-transcrever**: escolhe outro idioma ou
outro modelo e roda de novo direto do MP3 — sem baixar nem converter outra vez. Útil quando o
idioma saiu errado ou você quer comparar modelos. O texto anterior é substituído.

Só no modo local: na nuvem não há arquivo em disco para reaproveitar.

## Dois modos

O modo é escolhido sozinho, pela presença dos binários — não há configuração.

| | **local** | **nuvem** |
|---|---|---|
| Transcrição | `mlx_whisper` (GPU Metal) | API da Groq — `whisper-large-v3-turbo` |
| Entrada | arquivo do computador (até 5.000 MB) ou link do YouTube / Instagram | arquivo até 4 MB, ou link direto de mídia |
| Custo | zero | ~US$ 0,04 por hora de áudio |
| Privacidade | nada sai da máquina | o áudio vai para a Groq |

Para publicar, defina `GROQ_API_KEY` (pegue em [console.groq.com](https://console.groq.com/keys))
nas variáveis de ambiente do projeto. Sem ela o site sobe, mas avisa que não consegue transcrever.

Link de *página* do YouTube não funciona no modo nuvem: extrair a mídia exige o `yt-dlp`, que é
Python e não roda em serverless. Use o modo local para esses links — lá é offline e gratuito.

## Limitações

- **Apple Silicon.** O `mlx-whisper` usa o framework MLX da Apple. Em Intel ou Linux, troque por
  `faster-whisper` — só a função `stepTranscribe` muda.
- **Roda local.** Depende de processos externos e de disco; não funciona em serverless (Vercel).
- **Um job por vez, na prática.** Nada impede disparar vários, mas eles disputam a mesma GPU.
- **Vídeos longos.** Uma hora de áudio leva alguns minutos no `large-v3-turbo`. Use `small` se
  quiser rapidez e puder abrir mão de um pouco de precisão.

## Aviso

Baixar vídeos do YouTube e do Instagram contraria os Termos de Serviço dessas plataformas. Use
com conteúdo próprio, de licença aberta ou dentro do que a lei permitir.
