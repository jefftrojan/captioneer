export interface EngineInfo {
  id: string;
  label: string;
  origin: string;
  available: boolean;
}
export interface Language {
  code: string;
  name: string;
}

export async function getHealth(): Promise<{
  modelReady: boolean;
  asrReady: boolean;
}> {
  const r = await fetch("/api/health");
  return r.json();
}

export interface AsrCue {
  index: number;
  start: string;
  end: string;
  text: string;
}

export async function transcribe(
  file: File,
  language: string,
): Promise<AsrCue[]> {
  const form = new FormData();
  form.append("file", file);
  form.append("language", language);
  const r = await fetch("/api/transcribe", { method: "POST", body: form });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error ?? `Transcription failed (${r.status})`);
  }
  return (await r.json()).cues as AsrCue[];
}

export interface UrlResult {
  cues: AsrCue[];
  sourceUsed: "subtitles" | "asr";
  title: string;
  truncated: boolean;
}

/** URL a <video> element can play directly for a URL-sourced session — the
 * server downloads it once (yt-dlp) and serves the real file, cached, so
 * playback/seeking/thumbnails work exactly like an uploaded file instead of
 * an opaque platform embed. */
export function videoProxyUrl(url: string): string {
  return `/api/video-proxy?url=${encodeURIComponent(url)}`;
}

export async function fetchFromUrl(
  url: string,
  language: string,
): Promise<UrlResult> {
  const r = await fetch("/api/from-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, language }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error ?? `URL fetch failed (${r.status})`);
  }
  return (await r.json()) as UrlResult;
}

export async function burnVideo(params: {
  srt: string;
  file?: File;
  url?: string;
  startSec?: number;
  endSec?: number;
  /** Replace the audio track with a synthesized dub in `dubTarget`
   * (FLORES code, e.g. "kin_Latn") instead of the source's original audio. */
  dub?: boolean;
  dubTarget?: string;
  /** Set false to skip the on-screen caption overlay (e.g. dub-only). */
  burnCaptions?: boolean;
}): Promise<Blob> {
  const form = new FormData();
  form.append("srt", params.srt);
  if (params.file) form.append("video", params.file);
  if (params.url) form.append("url", params.url);
  if (params.startSec != null) form.append("startSec", String(params.startSec));
  if (params.endSec != null) form.append("endSec", String(params.endSec));
  if (params.dub) {
    form.append("dub", "true");
    form.append("dubTarget", params.dubTarget ?? "");
  }
  if (params.burnCaptions === false) form.append("burnCaptions", "false");
  const r = await fetch("/api/burn", { method: "POST", body: form });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error ?? `Render failed (${r.status})`);
  }
  return r.blob();
}

export type LiveMessage =
  | { type: "cues"; cues: AsrCue[] }
  | { type: "error"; message: string };

/** Open the live-mic websocket. Each binary message sent on it is one
 * independently-decodable audio window; the server replies with one
 * `LiveMessage` per window, in order. */
export function openLiveSocket(language: string): WebSocket {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(
    `${proto}//${location.host}/ws/live?language=${encodeURIComponent(language)}`,
  );
}

export async function getEngines(): Promise<{
  engines: EngineInfo[];
  languages: Language[];
}> {
  const r = await fetch("/api/engines");
  return r.json();
}

export async function translate(
  texts: string[],
  source: string,
  target: string,
  engine: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const r = await fetch("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts, source, target, engine }),
    signal,
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error ?? `Translation failed (${r.status})`);
  }
  const data = await r.json();
  return data.translations as string[];
}
