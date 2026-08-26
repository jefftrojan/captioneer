import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import multer from "multer";
import { WebSocketServer } from "ws";
import { env as hfEnv } from "@huggingface/transformers";
import { LANGUAGES } from "./engines/types.js";
import { defaultEngine, getEngine, listEngines } from "./engines/registry.js";
import { transcribe, transcribeKinyarwanda, warmupAsr } from "./asr.js";
import { downloadVideoClip, fetchFromUrl } from "./urlfetch.js";
import { burnSubtitles } from "./burn.js";
import { synthesizeDub } from "./dub.js";
import { parseSubtitles } from "./subtitles.js";
import { handleLiveConnection } from "./live.js";

// Load .env from the server dir or the repo root (no-op in containers where
// the environment is provided directly by docker compose).
for (const p of [".env", "../.env"]) {
  if (existsSync(p)) {
    try {
      process.loadEnvFile(p);
    } catch {
      /* ignore */
    }
  }
}

// Persist downloaded model weights to the HF cache dir (a Docker volume in
// production) so they survive container restarts.
if (process.env.HF_HOME) hfEnv.cacheDir = process.env.HF_HOME;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const app = express();
app.use(cors());
app.use(express.json({ limit: "8mb" }));
const upload = multer({ limits: { fileSize: 200 * 1024 * 1024 } });

let modelReady = false;
let asrReady = false;

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, modelReady, asrReady, defaultEngine: defaultEngine.id });
});

app.get("/api/engines", async (_req, res) => {
  res.json({ engines: await listEngines(), languages: LANGUAGES });
});

app.post("/api/translate", async (req, res) => {
  try {
    const { texts, source, target, engine } = req.body ?? {};
    if (!Array.isArray(texts) || !source || !target) {
      return res
        .status(400)
        .json({ error: "Expected { texts: string[], source, target }" });
    }
    const eng = getEngine(engine);
    const nonEmpty: { i: number; text: string }[] = [];
    texts.forEach((t: string, i: number) => {
      if (t && t.trim()) nonEmpty.push({ i, text: t });
    });

    const translatedNonEmpty = nonEmpty.length
      ? await eng.translate({
          texts: nonEmpty.map((x) => x.text),
          source,
          target,
        })
      : [];

    const translations = texts.map((t: string) => t);
    nonEmpty.forEach((x, k) => {
      translations[x.i] = translatedNonEmpty[k];
    });

    res.json({ translations, engine: eng.id });
  } catch (err: any) {
    console.error("[translate] error:", err);
    res.status(500).json({ error: err?.message ?? "translation failed" });
  }
});

// Video/audio -> timestamped captions (Whisper ASR).
app.post("/api/transcribe", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const language = (req.body?.language as string) || "english";
    // Kinyarwanda speech goes to the Digital Umuganda Whisper model in the
    // sidecar; Whisper-base has no Kinyarwanda, so other langs stay local.
    const cues =
      language === "kinyarwanda"
        ? await transcribeKinyarwanda(req.file.buffer)
        : await transcribe(req.file.buffer, language);
    res.json({ cues });
  } catch (err: any) {
    console.error("[transcribe] error:", err);
    res.status(500).json({ error: err?.message ?? "transcription failed" });
  }
});

// Video URL (YouTube etc.) -> captions, via existing subtitles or ASR fallback.
app.post("/api/from-url", async (req, res) => {
  try {
    const { url, language, mode } = req.body ?? {};
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "Expected { url }" });
    }
    const result = await fetchFromUrl(url, language || "english", mode || "auto");
    res.json(result);
  } catch (err: any) {
    console.error("[from-url] error:", err);
    res.status(500).json({ error: err?.message ?? "URL fetch failed" });
  }
});

// Downloads a URL source once (yt-dlp) and serves the real file, so the
// editor's <video> element (preview pane, live transcript sync, timeline
// thumbnails) works on a URL session exactly like an uploaded one instead of
// an opaque YouTube iframe embed. Cached per URL — repeated requests (the
// browser re-fetches on every seek via Range headers) reuse the same file
// rather than re-running yt-dlp. A small in-memory LRU-ish cache, evicting
// the oldest entry past VIDEO_PROXY_MAX_CACHE — fine for a single-user dev
// server, not meant to survive a restart or scale to many concurrent users.
const videoProxyCache = new Map<string, { dir: string; filePath: string }>();
const VIDEO_PROXY_MAX_CACHE = 3;

app.get("/api/video-proxy", async (req, res) => {
  try {
    const url = req.query.url;
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "Missing url" });
    }
    let entry = videoProxyCache.get(url);
    if (!entry) {
      const dir = await mkdtemp(path.join(os.tmpdir(), "captioneer-preview-"));
      const filePath = await downloadVideoClip(dir, url);
      entry = { dir, filePath };
      videoProxyCache.set(url, entry);
      if (videoProxyCache.size > VIDEO_PROXY_MAX_CACHE) {
        const oldestKey = videoProxyCache.keys().next().value as string;
        const oldest = videoProxyCache.get(oldestKey)!;
        videoProxyCache.delete(oldestKey);
        rm(oldest.dir, { recursive: true, force: true }).catch(() => {});
      }
    }
    res.sendFile(entry.filePath);
  } catch (err: any) {
    console.error("[video-proxy] error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err?.message ?? "Could not load video" });
    }
  }
});

// Burn translated captions into the video (uploaded file or URL) -> MP4.
// Optionally dubs the audio too (see `dub`/`dubTarget` below).
app.post("/api/burn", upload.single("video"), async (req, res) => {
  try {
    const srt = req.body?.srt as string;
    const url = req.body?.url as string | undefined;
    const startSec = req.body?.startSec != null ? Number(req.body.startSec) : undefined;
    const endSec = req.body?.endSec != null ? Number(req.body.endSec) : undefined;
    const dub = req.body?.dub === "true";
    const dubTarget = req.body?.dubTarget as string | undefined;
    const burnCaptions = req.body?.burnCaptions !== "false";
    if (!srt) return res.status(400).json({ error: "Missing subtitles (srt)" });
    if (!req.file && !url) {
      return res.status(400).json({ error: "Provide a video file or a url" });
    }
    if (dub && !dubTarget) {
      return res.status(400).json({ error: "Missing dubTarget language for dubbing" });
    }
    // Dub audio is synthesized from the exact same parsed cues as `srt`, so
    // it always lands on whichever timeline convention (absolute vs.
    // 0-based-rebased) the caller already used for the burned captions.
    const dubAudioBuf = dub
      ? await synthesizeDub(parseSubtitles(srt), dubTarget!)
      : undefined;
    const { outPath, dir } = await burnSubtitles({
      videoBuf: req.file?.buffer,
      url,
      srt,
      startSec,
      endSec,
      burnCaptions,
      dubAudioBuf,
    });
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="captioned.mp4"');
    const stream = createReadStream(outPath);
    stream.pipe(res);
    const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => {});
    res.on("finish", cleanup);
    res.on("close", cleanup);
  } catch (err: any) {
    console.error("[burn] error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err?.message ?? "Burn failed" });
    }
  }
});

// Serve the built web app in production (single-container deploy).
const STATIC_DIR =
  process.env.STATIC_DIR ?? path.resolve(__dirname, "../../web/dist");
if (existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(STATIC_DIR, "index.html"));
  });
  console.log(`[captioneer] serving static web from ${STATIC_DIR}`);
}

const httpServer = app.listen(PORT, () => {
  console.log(`[captioneer] server on http://localhost:${PORT}`);
  defaultEngine
    .warmup()
    .then(() => {
      modelReady = true;
    })
    .catch((e) => console.error("[warmup] failed:", e));
  warmupAsr()
    .then(() => {
      asrReady = true;
    })
    .catch((e) => console.error("[asr warmup] failed:", e));
});

// Live mic transcription: short rolling audio windows over a websocket.
const liveWss = new WebSocketServer({ server: httpServer, path: "/ws/live" });
liveWss.on("connection", handleLiveConnection);
