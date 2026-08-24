# Transcritor — Registro de Construção e Configuração

Data: 2026-08-21
Máquina: macOS (Darwin 25.5), Apple Silicon arm64, 8 GB RAM
Projeto: `~/Desktop/claude_code/deivid/transcritor`

## Objetivo

App web **local** que recebe o link de um vídeo do YouTube ou Instagram, baixa a mídia,
converte o áudio para MP3 e transcreve o conteúdo para texto. Tudo roda na máquina:
nenhum áudio sai do computador e não há custo por transcrição.

```
link → yt-dlp → ffmpeg (MP3) → mlx-whisper (GPU Metal) → txt · srt · vtt · json
```

## Decisões tomadas no início

Duas escolhas do usuário definiram o resto:

1. **Interface: app web local (Next.js)** em vez de CLI — queria acompanhar progresso e
   baixar os arquivos pelo navegador.
2. **Transcrição: Whisper local** em vez de API (Groq / Replicate) — grátis, offline, sem
   API key, áudio nunca sai da máquina.

Consequência importante: **o pipeline local não roda em serverless**. Ele depende de processos
externos e de disco persistente.

> **Revisto em 2026-08-23.** O app ganhou um segundo modo para poder ser publicado numa URL.
> A decisão original continua valendo **na máquina**: rodando local, é Whisper offline, custo
> zero, nada sai do computador. O modo nuvem só entra onde os binários não existem. Veja
> "Dois modos de execução".

## Diagnóstico do ambiente (antes)

| Item | Estado |
|---|---|
| Node | v22.12.0 ✅ |
| uv | 0.11.29 ✅ |
| Python | 3.9.6 (do sistema) |
| Homebrew | **ausente** |
| ffmpeg | **ausente** |
| yt-dlp | **ausente** |
| Chip / RAM | arm64 / 8 GB |

Sem Homebrew, todas as dependências foram instaladas via `uv` ou binário estático.

## O que foi instalado (passo a passo)

### 1. yt-dlp

```bash
uv tool install yt-dlp        # → 2026.8.19, executável em ~/.local/bin/yt-dlp
```

### 2. mlx-whisper (Whisper acelerado pela GPU do Apple Silicon)

```bash
uv tool install mlx-whisper   # → 0.4.3 (+ mlx-metal 0.32.1), executável mlx_whisper
```

Escolhido em vez de `whisper.cpp` (exigiria cmake, que também não existe na máquina) e de
`faster-whisper` (roda em CPU). O MLX é o framework da Apple e usa a GPU via Metal, com
wheels prontas — zero compilação.

### 3. ffmpeg sem Homebrew

O pacote Python `imageio-ffmpeg` embute um ffmpeg estático completo para macOS arm64.
Foi extraído e fixado em `~/.local/bin` para não depender do cache do uv:

```bash
FF=$(uv run --with imageio-ffmpeg python -c "import imageio_ffmpeg as f; print(f.get_ffmpeg_exe())")
cp "$FF" ~/.local/bin/ffmpeg && chmod +x ~/.local/bin/ffmpeg
xattr -d com.apple.quarantine ~/.local/bin/ffmpeg 2>/dev/null
```

Versão: **ffmpeg 7.1**, com `libmp3lame` confirmado (verificado com `-encoders`).
Observação: esse build **não traz `ffprobe`** — o pipeline foi escrito para não precisar
dele (a duração vem do JSON do yt-dlp).

### 4. Modelo Whisper

`mlx-community/whisper-large-v3-turbo`, ~1,5 GB, baixado automaticamente na primeira
execução para `~/.cache/huggingface`. O download levou ~3 min; depois fica em cache.

### 5. Scaffold do app

```bash
npx create-next-app@latest transcritor \
  --ts --tailwind --app --src-dir --no-eslint \
  --turbopack --import-alias "@/*" --use-npm --yes
```

Resultado: **Next 16.3.2**, React 19.2.8, Tailwind 4, TypeScript.

## Dois modos de execução

A escolha é automática, sem configuração: se `yt-dlp`, `ffmpeg` e `mlx_whisper` existem, é
local. Em serverless (`process.env.VERCEL`) é sempre nuvem.

| | **local** | **nuvem** |
|---|---|---|
| Onde roda | sua máquina | Vercel (serverless) |
| Transcrição | `mlx_whisper` na GPU Metal | API da Groq (`whisper-large-v3-turbo`) |
| Entrada | **arquivo do computador (≤ 5.000 MB)** ou link do YouTube / Instagram | arquivo enviado (≤ 4 MB) ou **link direto** de mídia |
| Custo | zero | ~US$ 0,04 por hora de áudio |
| Privacidade | nada sai da máquina | o áudio vai para a Groq |
| Progresso | SSE, etapa a etapa | síncrono — o job volta pronto |
| Arquivos | txt/srt/vtt/json em disco | gerados no navegador a partir dos segmentos |

**Por que a nuvem não aceita link do YouTube.** Extrair a mídia de uma *página* exige o
`yt-dlp`, que é Python e não roda em serverless — e o YouTube ainda bloqueia IP de datacenter.
A Groq baixa apenas URLs que apontam direto para um arquivo de áudio/vídeo. Para links de
página, use o modo local.

**Por que a transcrição na nuvem é síncrona.** No serverless a função pode congelar assim que
responde, então o padrão fire-and-forget + SSE do modo local não é confiável. A rota transcreve
dentro do próprio request e devolve o job já em `done`. Como `done` é terminal, a UI não abre
`EventSource` — a mesma tela serve aos dois modos sem ramificação.

**Upload de arquivo local.** O corpo do request vai **cru**, não como multipart: o nome do
arquivo e as opções viajam na query string. Isso permite gravar em disco por streaming
(`Readable.fromWeb` → `createWriteStream`), então um vídeo de gigabytes nunca fica inteiro na
memória. O teto de 5.000 MB é só uma trava contra encher o disco, checada pelo `Content-Length`
antes de gravar qualquer byte — não é limite técnico. Arquivo enviado pula metadata e download:
`runPipelineFromFile()` vai direto para conversão e transcrição, e por isso os pesos da barra são
outros (`FILE_SPAN`: conversão 0–15%, transcrição 15–100%).

**Áudio longo é transcrito em fatias.** Acima de 30 min o `audio.mp3` é cortado pelo ffmpeg em
pedaços de 10 min (`-f segment -c copy`, sem recodificar, quase instantâneo) e cada parte vai ao
mlx_whisper separadamente; os tempos de cada fatia são deslocados por `índice × 600 s` na leitura
do stdout. Motivo: numa máquina de 8 GB o mlx_whisper carrega o áudio inteiro e **morre em
arquivos de horas** — saindo com código 0 e sem escrever nada. No modo fatiado somos nós que
escrevemos `audio.txt/srt/vtt/json`, porque cada parte gera os seus e eles precisam ser costurados.

**Nunca concluir vazio.** Se a transcrição termina sem nenhum segmento e sem texto, o job vira
**erro** com uma mensagem acionável ("tente um modelo menor"), em vez de "Concluído" sem nada para
baixar. Esse era exatamente o sintoma de um arquivo de 7,8 h com o modelo `medium`.

**Re-transcrever.** Um job concluído guarda o `audio.mp3`, então dá para rodar a transcrição de
novo trocando idioma ou modelo sem baixar nem converter nada — só a etapa cara é refeita, e ela
ocupa a barra inteira. O resultado é substituído **no mesmo job** (segmentos e texto são zerados
antes de começar), o que mantém o uso de disco constante. Só existe no modo local: na nuvem não há
MP3 em disco para reaproveitar.

**Limite de 4 MB no upload da nuvem.** É a restrição de corpo de request das funções da Vercel (4,5 MB),
não da Groq (que aceita 25 MB no free). Por link direto não há esse limite, porque o arquivo
nunca passa pela nossa função — a Groq busca sozinha.

## Arquitetura

| Arquivo | Responsabilidade |
|---|---|
| `src/lib/bin.ts` | Resolve `yt-dlp`, `ffmpeg` e `mlx_whisper` no disco e injeta um PATH completo nos processos filhos. |
| `src/lib/types.ts` | Tipos compartilhados servidor/cliente. Sem `node:*`, para poder ser importado do componente client. |
| `src/lib/jobs.ts` | Store de jobs em memória + espelho em disco (`job.json`). Um `EventEmitter` por job. |
| `src/lib/pipeline.ts` | As 4 etapas: metadata → download → convert → transcribe. `runPipelineFromFile()` entra direto na conversão, para arquivo enviado. |
| `src/lib/format.ts` | Formatação de duração, timestamp e tempo relativo. |
| `src/lib/mode.ts` | Decide local vs nuvem, expõe o limite de upload e trava a escrita em disco no serverless. |
| `src/lib/cloud.ts` | Chamada à API da Groq (`file` ou `url`) e tradução dos erros dela. |
| `src/lib/subtitles.ts` | Monta txt/srt/vtt/json no navegador quando não há disco. |
| `src/app/api/health/route.ts` | Diz o modo ativo, quais binários faltam e se há `GROQ_API_KEY`. |
| `src/app/api/jobs/route.ts` | `GET` lista. `POST` ramifica: pipeline local (assíncrono) ou Groq (síncrono, aceita multipart). |
| `src/app/api/jobs/[id]/route.ts` | `GET` um job, `DELETE` remove job + pasta. |
| `src/app/api/jobs/[id]/events/route.ts` | **SSE** — stream de progresso. |
| `src/app/api/jobs/[id]/file/route.ts` | Download dos artefatos com nome amigável. |
| `src/app/api/jobs/[id]/retranscribe/route.ts` | Re-transcreve o job reaproveitando o `audio.mp3` em disco. |
| `src/app/page.tsx` | Formulário, opções e lista de jobs. Um `EventSource` por job em andamento. |
| `src/components/job-card.tsx` | Card com thumbnail, barra, downloads e transcrição. |

### Detalhes que não são óbvios

**PATH.** O Next herda o PATH de quem iniciou o servidor, que normalmente **não** inclui
`~/.local/bin`. Sem o `bin.ts` resolvendo na mão e injetando o PATH em cada `spawn`, o app
funciona no terminal e falha em qualquer outro contexto. Esse é o ponto mais frágil da
integração.

**Store em `globalThis`.** O `next dev` reavalia módulos a cada hot-reload. O store vive em
`globalThis.__transcritor` para os jobs em andamento não sumirem quando um arquivo é salvo.

**Persistência em disco é seletiva.** O progresso emite dezenas de updates por segundo;
gravar `job.json` em todos seria desperdício. Só grava em mudança de estágio e no fim
(`updateJob(id, patch, save = true)`).

**Progresso vem do stdout dos processos**, cada um com um formato:

| Etapa | Fonte | Padrão |
|---|---|---|
| download | yt-dlp `--newline` | `[download]  42.1% of ...` |
| conversão | ffmpeg `-progress pipe:1` | `out_time_us=12340000` |
| transcrição | mlx_whisper `--verbose True` | `[00:12.480 --> 00:15.200]  texto` |
| modelo | huggingface_hub (tqdm) | `Fetching 4 files:  25%` |

Pesos na barra global: metadata 0–5%, download 5–40%, conversão 40–50%, transcrição 50–100%.

**Duração ausente é sondada.** O YouTube informa a duração no metadado; o **Instagram não**
(`duration: None`). Sem ela, a conversão e a transcrição ficam sem denominador para o
progresso. Entre o download e a conversão, `probeDuration()` abre o arquivo com
`ffmpeg -i` e lê o `Duration:` do stderr — o ffmpeg sai com erro por falta de output, e isso
é esperado. Resolve a falta do `ffprobe` no build estático.

**Nomes de arquivo fixos no disco.** O `--output-name audio` do mlx_whisper garante
`audio.txt/srt/vtt/json/tsv`. O nome bonito (derivado do título) só aparece no
`Content-Disposition` do download — evita ter que sanear nomes no filesystem.

**Só o áudio, por padrão.** `-f ba/b` baixa apenas a faixa de áudio, bem mais rápido que o
vídeo completo. O MP4 só é baixado e mantido se "guardar o vídeo" estiver marcado.

## Validação executada

Nada foi entregue sem teste real:

| Teste | Resultado |
|---|---|
| ffmpeg codifica MP3 | ✅ tom de 1s → mp3 válido |
| Whisper em português | ✅ áudio gerado com `say`, transcrito com acentos e pontuação corretos |
| Extrator do YouTube | ✅ metadados de vídeo CC-BY da Blender Foundation |
| Extratores do Instagram | ✅ presentes (post, story, tag; `instagram:user` está quebrado no upstream) |
| `tsc --noEmit` | ✅ limpo |
| **Pipeline ponta a ponta** | ✅ trailer do Sintel (CC-BY, 52s): 4 etapas, `done` 100%, 6 arquivos gerados |
| Download do MP3 | ✅ HTTP 200, `Content-Disposition` com nome derivado do título |
| Interface no Chrome | ✅ card, barra verde, botões e transcrição com timestamps |
| **Pipeline no Instagram** | ✅ reel do NASA JPL (domínio público): 4 etapas, `done` 100%, 6 arquivos — **sem login** |
| Sonda de duração | ✅ reel sem `duration` no metadado passou de `None` para `58.4 s` antes da conversão |
| Parse do progresso do ffmpeg | ✅ arquivo de 20 min emite `out_time_us` em incrementos reais |

## Problemas encontrados e resolvidos

1. **ffmpeg sem Homebrew** — a máquina não tem brew e o `uv` não instala ffmpeg. Resolvido
   extraindo o binário estático embutido no pacote `imageio-ffmpeg` e copiando para
   `~/.local/bin`, para não depender do cache do uv (que pode ser podado).
2. **Regex de diacríticos corrompido** — o heredoc gravou caracteres combinantes literais em
   vez do range. Corrigido para `/[\u0300-\u036f]/g`.
3. **`JobOptions` não importado** em `jobs.ts` após extrair os tipos para `types.ts` —
   pego pelo `tsc`.
4. **Mensagem enganosa** — "Baixando o modelo… (só na 1ª vez)" aparecia sempre, porque o
   `huggingface_hub` roda a verificação de cache em toda execução. Trocada por
   "Preparando o modelo Whisper… X%".
5. **Falso alarme** — os primeiros screenshots mostraram a lista vazia. Não era bug: a página
   ainda não tinha hidratado. Confirmado que o card renderiza normalmente.
6. **Instagram não informa a duração** (`duration: None` no metadado do yt-dlp, ao contrário do
   YouTube). Sem denominador, a barra pulava de 40% para 50% na conversão e a transcrição caía
   num fallback por contagem de trechos. Resolvido com `probeDuration()` entre o download e a
   conversão. Degradava sem quebrar, mas o progresso ficava pouco informativo.

## Comandos de uso

```bash
cd ~/Desktop/claude_code/deivid/transcritor
npm run dev                  # http://localhost:3000
```

```bash
# Verificar dependências pela API
curl -s localhost:3000/api/health | python3 -m json.tool

# Atualizar as ferramentas
uv tool upgrade yt-dlp       # o YouTube muda de proteção com frequência
uv tool upgrade mlx-whisper
```

## Onde ficam os arquivos

```
downloads/<job-id>/
  job.json     metadados (o histórico é reconstruído daqui após um restart)
  audio.mp3    áudio convertido
  audio.txt    transcrição corrida
  audio.srt    legenda
  audio.vtt    legenda (web)
  audio.json   segmentos com timestamps
  audio.tsv    segmentos (tabular)
  source.mp4   só se "guardar o vídeo" estiver ligado
```

`downloads/` está no `.gitignore`. Remover um job pela interface apaga a pasta inteira.

## Troubleshooting

- **"Dependências faltando" no topo da página** — o `bin.ts` não achou algum binário. Confira
  `ls ~/.local/bin` ou aponte o caminho no `.env.local` (`YTDLP_PATH`, `FFMPEG_PATH`,
  `MLX_WHISPER_PATH`).
- **Download falha em vídeo público** — quase sempre é yt-dlp desatualizado:
  `uv tool upgrade yt-dlp`.
- **Instagram privado/restrito** — marcar "usar cookies do navegador". No macOS o Chrome pede
  permissão de Keychain na primeira vez.
- **Transcrição lenta** — com 8 GB de RAM, o `large-v3-turbo` é o teto confortável. Para
  ganhar velocidade, trocar para `whisper-small-mlx` nas opções.
- **Job travado após reiniciar o servidor** — jobs não terminados são marcados como erro na
  releitura do disco. Basta rodar de novo.

## Limitações conhecidas

- **Apple Silicon apenas.** O `mlx-whisper` depende do MLX. Em Intel ou Linux, trocar por
  `faster-whisper` — só a função `stepTranscribe` muda.
- **O pipeline local não roda em serverless.** Depende de processos externos e disco. Publicado, o app cai no modo nuvem — sem link de página do YouTube/Instagram e com upload limitado a 4 MB.
- **Modelo grande + áudio longo ainda pode faltar memória.** O fatiamento resolve o caso comum,
  mas com 8 GB o `large-v3-turbo` em arquivos de várias horas continua arriscado. Se falhar, o app
  agora avisa e sugere `small` ou `tiny`.
- **Um job por vez, na prática.** Nada impede disparar vários, mas eles disputam a mesma GPU.
- **Instagram muda as proteções com frequência.** Posts e reels públicos funcionam sem login;
  se um dia parar, o conserto quase sempre é `uv tool upgrade yt-dlp`. Conteúdo privado e
  stories exigem o checkbox de cookies. O extrator `instagram:user` (perfil inteiro) está
  marcado como quebrado no próprio yt-dlp — use links individuais.
- **Sem `ffprobe`** no build do imageio-ffmpeg. Hoje não faz falta: a duração é obtida do JSON
  do yt-dlp ou, quando ele não informa, por `probeDuration()`. Se algum recurso futuro precisar
  de fato do ffprobe, instalar um build completo.

## Histórico de alterações

**2026-08-21 — construção inicial.** Diagnóstico do ambiente, instalação das três dependências
sem Homebrew, scaffold do Next 16, pipeline completo, API com SSE e interface. Validado ponta a
ponta no YouTube (trailer do Sintel, CC-BY).

**2026-08-22 — Instagram verificado e sonda de duração.** Confirmado que reels e posts públicos
do Instagram funcionam **sem login** (testado com reel do NASA JPL, domínio público). Nesse
teste apareceu a ausência de `duration` no metadado; adicionada a função `probeDuration()` em
`src/lib/pipeline.ts`, chamada entre o download e a conversão quando o extrator não informa a
duração. Verificado separadamente que a sonda lê `Duration:` corretamente e que o
`-progress pipe:1` do ffmpeg emite `out_time_us` em incrementos reais num arquivo de 20 min.

**2026-08-23 — modo nuvem e publicação na Vercel.** O app passou a ter dois modos, escolhidos
automaticamente. O modo local ficou intacto. Adicionados `src/lib/mode.ts`, `src/lib/cloud.ts` e
`src/lib/subtitles.ts`; `jobs.ts` deixou de tocar o disco quando `process.env.VERCEL` está
definido; `page.tsx` e `job-card.tsx` se adaptam ao modo (upload de arquivo, downloads gerados no
navegador). Corrigido também um aviso do Turbopack: a busca de binários em `bin.ts` disparava
"dynamic filesystem access" e fazia o tracer empacotar o projeto inteiro — resolvido com
`/* turbopackIgnore: true */`, já que os caminhos ficam fora do projeto. Repositório próprio criado
e publicado em github.com/deividvs/Transcritor.

**2026-08-24 — upload de arquivo local.** Antes só dava para colar link; agora dá para transcrever
vídeo/áudio que já está na máquina, sem limite prático de tamanho (teto de 5.000 MB) e nas duas
pontas: o modo local grava por streaming e roda o pipeline normal, o modo nuvem manda o arquivo
para a Groq. O corpo vai cru em vez de multipart justamente para permitir o streaming. Validado
ponta a ponta com um MP4: duração sondada, MP3 gerado, transcrição correta em português e os 6
artefatos em disco. Nessa sessão também apareceu — e foi resolvido — um problema de ambiente: vários
arquivos do `node_modules` liam como 0 byte apesar do metadado correto, o que fazia `next dev` e
`next build` saírem com código 0 sem imprimir nada; `npm ci` resolveu.

**2026-08-24 — re-transcrever job existente.** Adicionada a rota
`/api/jobs/[id]/retranscribe` e o controle no card. Reaproveita o `audio.mp3` já em disco para
corrigir idioma ou trocar de modelo sem repetir download e conversão. Como o job volta para
`transcribing`, o `EventSource` reabre sozinho e o progresso aparece sem nenhuma mudança na
lógica de SSE. Validado ponta a ponta: job em `pt`/`large-v3-turbo` re-transcrito em
`en`/`small`, com o texto substituído corretamente.

**2026-08-24 — fatiamento de áudio longo e fim do "Concluído" vazio.** Um upload de 7,8 h
(`lab01.mp4`, MP3 de 214 MB, modelo `medium`) rodou 48 min, terminou marcado como **Concluído** e
não gerou transcrição nenhuma: zero segmentos, nenhum arquivo, nada para baixar. Diagnóstico: o
arquivo estava íntegro (60 s dele transcrevem normalmente) — o problema era escala, com o
mlx_whisper morrendo por memória e saindo com código 0. Duas correções: (1) `stepTranscribe` agora
fatia o áudio acima de 30 min e costura os segmentos com deslocamento de tempo; (2) resultado vazio
vira erro com mensagem acionável, nunca mais "Concluído" sem texto. Nessa sessão também foram
removidas 39 pastas duplicadas com sufixo `" 2"` dentro de `node_modules`, criadas por conflito de
sincronização, que quebravam o type-check com `TS2688: Cannot find type definition file`.

## Aviso

Baixar vídeos do YouTube e do Instagram contraria os Termos de Serviço dessas plataformas.
Uso previsto: conteúdo próprio, de licença aberta, ou dentro do que a lei permitir.
