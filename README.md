# 🎬 Captioneer

Add and translate video captions between **English and Kinyarwanda** —
timestamps preserved. Captioneer can translate existing subtitle files **and**
generate captions straight from a video's audio. It runs translation models
**locally** and ships a slot for a **Rwanda-built model from Digital Umuganda /
mbazaNLP** so you can compare a global model against a Kinyarwanda specialist.

## What it does

- **Subtitle file → translated subtitles.** Open `.srt`/`.vtt`, translate every
  cue, download the result. Timing never changes.
- **Video → captions → translation.** Upload a video/audio file; Whisper ASR
  transcribes it into timestamped cues, which you then translate.
- **YouTube / URL → captions.** Paste a video link; Captioneer grabs the video's
  own captions if present (fast), otherwise downloads the audio (via `yt-dlp`)
  and transcribes it — then translate as usual. If a site blocks the download
  (bot-check), `yt-dlp` retries through alternate YouTube player clients
  (`android`/`web`/`tv` by default — configurable via `YT_DLP_PLAYER_CLIENTS`)
  before giving up.
- **Two engines, side by side.** NLLB-200 (global, runs on-device) and a
  Digital Umuganda / Mbaza NLLB finetune (Kinyarwanda specialist).
- **Clip trimming.** Pick a start/end range on the timeline to export or burn
  just that section instead of the whole video.
- **Burn captions into the video.** Render the translated subtitles into the
  video with ffmpeg and download a finished `.mp4` (uploaded video or URL,
  full-length or trimmed to a range).
- **Live mic → captions.** Talk into the mic and captions fill in every few
  seconds (rolling ~4s windows over a websocket) — then translate as usual.
  Not instant transcription (Whisper needs a finished clip), but close.
- **Session history.** Every file/video/URL/live session is saved to the
  browser's local storage (title, cues, translations, render status) so you
  can pick up a past session without redoing translation.

## Web app pages

The UI (`web/src/pages/`) is a small multi-page workflow, navigated via the
sidebar (`web/src/Sidebar.tsx`) and shared state in `web/src/workflow.tsx`:

| Page | File | Role |
|------|------|------|
| Home | `Home.tsx` | Landing/dashboard |
| Create | `Create.tsx` | Pick a source: file, video/audio, URL, or live mic |
| Editor | `Editor.tsx` | Edit cues, translate, trim a clip range (`Timeline.tsx`), preview (`PreviewModal.tsx`), burn/export |
| Channels | `Channels.tsx` | URL-only intake plus recent YouTube sources |
| Videos | `Videos.tsx` | Full session history with per-entry export and render status |

## Architecture

| Service          | Tech                                   | Role |
|------------------|----------------------------------------|------|
| `web/`           | Vite + React + TS                      | UI; parses/serializes subtitles; in the container it's served by the Node server |
| `server/`        | Express + TS + `@huggingface/transformers` + ffmpeg | Translation (NLLB-200) + Whisper ASR API |
| `inference-py/`  | FastAPI + PyTorch + `transformers`     | Runs the Digital Umuganda / Mbaza NLLB finetune (PyTorch-only, can't run in JS) |

The Mbaza engine is only "available" when the Python sidecar answers its health
check, so the app still works fully on NLLB if the sidecar is off.

## Run with Docker (recommended — everything wired)

```bash
# .env already holds HF_TOKEN + model ids (gitignored).
docker compose up --build
```

Then open **http://localhost:8787**.

- First boot downloads model weights into Docker volumes (NLLB, Whisper, and the
  ~2.4 GB Digital Umuganda finetune). Subsequent boots are fast.
- The Mbaza/Digital Umuganda engine appears in the dropdown once the sidecar has
  finished loading its model (watch `docker compose logs -f inference`).

## Run locally (dev, no Docker)

```bash
npm run install:all
npm run dev          # server :8787 + web :5173 (open :5173)
```

NLLB translation and Whisper ASR work locally. The Digital Umuganda engine needs
the Python sidecar (torch), which is easiest via Docker — locally it just shows
as “not configured”, and NLLB handles everything.

## Configuration (`.env`)

```bash
HF_TOKEN=hf_...                                   # Hugging Face token
MBAZA_MODEL=mbazaNLP/Nllb_finetuned_general_en_kin # DU/Mbaza translation model (NLLB-1.3B)
MBAZA_ASR_MODEL=mbazaNLP/Whisper-Small-Kinyarwanda # DU Kinyarwanda ASR (used for spoken Kinyarwanda)
MBAZA_NUM_BEAMS=1                                  # 1=greedy/fast; raise on a GPU host for quality
MBAZA_URL=http://localhost:8000                   # sidecar URL (compose overrides)
```

> **Speed:** the Digital Umuganda model is **NLLB-1.3B**. On CPU (incl. Mac
> Docker) it runs ~40–75s per sentence even greedy, so it's best for comparing
> quality on a few cues. **NLLB-200** is the fast everyday engine; put the
> sidecar on a GPU host to make the DU model snappy.

> ⚠️ Rotate `HF_TOKEN` if it has been shared anywhere — it grants access to your
> Hugging Face account and org models.

## API

| Endpoint            | Body                                              | Returns |
|---------------------|---------------------------------------------------|---------|
| `GET /api/health`   | —                                                 | `{ modelReady, asrReady }` |
| `GET /api/engines`  | —                                                 | engines + languages |
| `POST /api/translate` | `{ texts[], source, target, engine }`           | `{ translations[] }` |
| `POST /api/transcribe` | multipart `file`, `language`                   | `{ cues[] }` |
| `POST /api/from-url` | `{ url, language, mode? }`                       | `{ cues[], sourceUsed, title, truncated }` |
| `POST /api/burn`    | multipart `srt` + (`video` file or `url`) + `startSec?`/`endSec?` | `video/mp4` (captions burned in, optionally trimmed) |
| `WS /ws/live?language=` | binary: one ~4s audio clip per message        | JSON `{ type: "cues", cues[] }` per window |

FLORES codes: English `eng_Latn`, Kinyarwanda `kin_Latn`.

## Notes & roadmap

- ASR uses `Xenova/whisper-base` for speed; bump to `whisper-small` for accuracy.
- Whisper has no native Kinyarwanda for general speech — spoken Kinyarwanda
  is routed to the DU `Whisper-Small-Kinyarwanda` model in the sidecar
  (`transcribeKinyarwanda`), so other languages stay on the fast local model.
- Session history lives in the browser's local storage only — it's per-device
  and doesn't sync or back up the original video/audio file, only its cues,
  translations, and (for URL sources) the source link.
- A persistent 403 on a URL fetch/burn usually means the site's bot-check is
  winning even through the player-client fallback — upload the file directly
  instead.
