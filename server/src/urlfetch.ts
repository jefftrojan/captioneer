import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type AsrCue, transcribe, transcribeKinyarwanda } from "./asr.js";
import { parseSubtitles } from "./subtitles.js";

const YT = process.env.YT_DLP_PATH ?? "yt-dlp";
// Cap audio transcription so a long video doesn't stall a demo. The subtitle
// path is unaffected (it grabs the whole track instantly).
const ASR_SECONDS = Number(process.env.URL_ASR_SECONDS ?? 180);

export type SourceUsed = "subtitles" | "asr";
export interface UrlResult {
  cues: AsrCue[];
  sourceUsed: SourceUsed;
  title: string;
  truncated: boolean;
}

const SUB_LANG: Record<string, string> = {
  english: "en",
  kinyarwanda: "rw",
  french: "fr",
  swahili: "sw",
};

function run(
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(YT, args);
    let stdout = "";
    let stderr = "";
    const to = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", (e) =>
      resolve({ code: -1, stdout, stderr: `${stderr}\n${String(e)}` }),
    );
    p.on("close", (code) => {
      clearTimeout(to);
      resolve({ code, stdout, stderr });
    });
  });
}

function ensureHttpUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("That doesn't look like a valid URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http(s) URLs are supported.");
  }
}

function friendlyError(stderr: string): string {
  const s = stderr.toLowerCase();
  if (s.includes("enoent")) {
    return "yt-dlp is not installed on the server.";
  }
  if (s.includes("sign in") || s.includes("bot") || s.includes("403")) {
    return "The site blocked the request (it may require sign-in). Try a different URL or upload the file.";
  }
  if (s.includes("unsupported url") || s.includes("unable to extract")) {
    return "Couldn't read that URL. Is it a public video page?";
  }
  return "Couldn't fetch that video.";
}

// Read the title from a *.info.json that yt-dlp wrote alongside its work, so we
// never pay for a second extraction just to get the title.
async function readTitle(dir: string): Promise<string> {
  const files = await readdir(dir).catch(() => [] as string[]);
  const info = files.find((f) => f.endsWith(".info.json"));
  if (!info) return "video";
  try {
    const json = JSON.parse(await readFile(path.join(dir, info), "utf8"));
    return json?.title || "video";
  } catch {
    return "video";
  }
}

async function trySubtitles(
  dir: string,
  url: string,
  language: string,
): Promise<AsrCue[]> {
  const code = SUB_LANG[language] ?? "en";
  const r = await run(
    [
      "--skip-download",
      "--no-warnings",
      "--write-subs",
      "--write-auto-subs",
      "--write-info-json", // grab the title in the same extraction (no 2nd call)
      "--sub-langs",
      `${code}.*,${code}`,
      "--sub-format",
      "vtt",
      "--convert-subs",
      "vtt",
      "-P",
      dir,
      "-o",
      "%(id)s.%(ext)s",
      url,
    ],
    90_000,
  );
  const files = await readdir(dir).catch(() => [] as string[]);
  const vtt = files.find((f) => f.endsWith(".vtt"));
  if (!vtt) {
    if (r.code !== 0 && r.code !== null) {
      // Non-fatal here: caller may still fall back to ASR.
    }
    return [];
  }
  const content = await readFile(path.join(dir, vtt), "utf8");
  return parseSubtitles(content);
}

async function downloadAudio(dir: string, url: string): Promise<string> {
  const base = [
    "-x",
    "--audio-format",
    "wav",
    "--no-warnings",
    "--write-info-json",
    "-P",
    dir,
    "-o",
    "%(id)s.%(ext)s",
    url,
  ];
  // Try a time-limited clip first; some extractors ignore sections, so fall back.
  let r = await run(
    ["--download-sections", `*0-${ASR_SECONDS}`, ...base],
    300_000,
  );
  let files = await readdir(dir).catch(() => [] as string[]);
  if (!files.some((f) => f.endsWith(".wav"))) {
    r = await run(base, 420_000);
    files = await readdir(dir).catch(() => [] as string[]);
  }
  const wav = files.find((f) => f.endsWith(".wav"));
  if (!wav) throw new Error(friendlyError(r.stderr));
  return path.join(dir, wav);
}

/** Download a (clipped) video by URL for caption burn-in. Returns the file path. */
export async function downloadVideoClip(dir: string, url: string): Promise<string> {
  ensureHttpUrl(url);
  const base = [
    "-f",
    "bv*+ba/b",
    "--merge-output-format",
    "mp4",
    "--no-warnings",
    "-P",
    dir,
    "-o",
    "video.%(ext)s",
    url,
  ];
  let r = await run(["--download-sections", `*0-${ASR_SECONDS}`, ...base], 420_000);
  let files = await readdir(dir).catch(() => [] as string[]);
  if (!files.some((f) => f.startsWith("video."))) {
    r = await run(base, 540_000);
    files = await readdir(dir).catch(() => [] as string[]);
  }
  const vid = files.find((f) => f.startsWith("video."));
  if (!vid) throw new Error(friendlyError(r.stderr));
  return path.join(dir, vid);
}

/**
 * Caption a video URL. Tries existing captions first (fast, accurate), then
 * falls back to downloading audio and running ASR.
 */
export async function fetchFromUrl(
  url: string,
  language = "english",
  mode: "auto" | "subtitles" | "asr" = "auto",
): Promise<UrlResult> {
  ensureHttpUrl(url);
  const dir = await mkdtemp(path.join(os.tmpdir(), "captioneer-"));
  try {
    if (mode !== "asr") {
      const subs = await trySubtitles(dir, url, language);
      if (subs.length) {
        const title = await readTitle(dir);
        return { cues: subs, sourceUsed: "subtitles", title, truncated: false };
      }
      if (mode === "subtitles") {
        throw new Error("No captions found on that video.");
      }
    }

    const audioPath = await downloadAudio(dir, url);
    const title = await readTitle(dir);
    const buf = await readFile(audioPath);
    const cues =
      language === "kinyarwanda"
        ? await transcribeKinyarwanda(buf)
        : await transcribe(buf, language);
    return { cues, sourceUsed: "asr", title, truncated: true };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
