import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AsrCue } from "./asr.js";
import { downloadVideoClip } from "./urlfetch.js";
import { synthesizeDubOverMusic } from "./dub.js";

// Tasteful subtitle styling (ASS): white text, black outline, lifted off the
// bottom edge. Quoted so the commas don't end the filtergraph.
const FORCE_STYLE =
  "force_style='FontName=Arial,Fontsize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00101010,BorderStyle=1,Outline=2,Shadow=0,MarginV=28'";

function runFfmpeg(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { cwd });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg failed: ${err.slice(-600)}`)),
    );
  });
}

/** Extract a WAV of a local video/audio file's audio track, at a quality
 * suitable for source separation (Demucs) — plain speech-dub decoding
 * downsamples to 16kHz mono, which would gut separation quality here. */
function extractAudioWav(videoPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", ["-i", videoPath, "-ar", "44100", "-ac", "2", "-f", "wav", "pipe:1"]);
    const chunks: Buffer[] = [];
    const errs: Buffer[] = [];
    ff.stdout.on("data", (d) => chunks.push(d));
    ff.stderr.on("data", (d) => errs.push(d));
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code !== 0) {
        return reject(
          new Error(`ffmpeg audio extract failed: ${Buffer.concat(errs).toString().slice(-400)}`),
        );
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

export interface BurnResult {
  outPath: string;
  dir: string;
}

/**
 * Burn an SRT into a video. Source is either an uploaded buffer or a URL
 * (downloaded as a clip). Runs entirely with relative filenames inside a temp
 * dir so the subtitles filter path needs no escaping. Caller deletes `dir`.
 */
export async function burnSubtitles(opts: {
  videoBuf?: Buffer;
  url?: string;
  srt: string;
  /** Trim to [startSec, endSec] of the source. Whether the caller's `srt`
   * should use absolute (original-timeline) or 0-based timestamps depends
   * on which trim path runs below: ffmpeg's `-ss/-to` (buffer source) reads
   * the subtitles filter against the pre-trim timeline (absolute), while a
   * ranged URL fetch is already pre-trimmed by yt-dlp before ffmpeg ever
   * sees it (0-based). See the `needsFfmpegTrim` branch below. */
  startSec?: number;
  endSec?: number;
  /** Whether to burn `srt` in as an on-screen overlay. Default true — set
   * false for a dub-only render with no visible captions. */
  burnCaptions?: boolean;
  /** Replaces the source's original audio track entirely (dubbing). Built
   * against the same absolute timeline as `srt`/the trim range, so it trims
   * identically alongside the video when a range is set. */
  dubAudioBuf?: Buffer;
  /** Music-video dubbing: separates vocals/instrumental and mixes narration
   * onto the kept instrumental instead of replacing the whole mix (see
   * synthesizeDubOverMusic). Mutually exclusive with dubAudioBuf — this
   * computes its own after the video file is resolved below, since it needs
   * to extract audio from the actual local file regardless of source. */
  dubMusic?: { cues: AsrCue[]; target: string };
}): Promise<BurnResult> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "captioneer-burn-"));
  const ranged = opts.startSec != null && opts.endSec != null;
  const burnCaptions = opts.burnCaptions ?? true;

  let videoName: string;
  if (opts.videoBuf) {
    videoName = "in.mp4";
    await writeFile(path.join(dir, videoName), opts.videoBuf);
  } else if (opts.url) {
    videoName = path.basename(
      await downloadVideoClip(dir, opts.url, opts.startSec, opts.endSec),
    );
  } else {
    throw new Error("No video provided to burn captions into.");
  }

  if (burnCaptions) {
    await writeFile(path.join(dir, "subs.srt"), opts.srt, "utf8");
  }

  let dubAudioBuf = opts.dubAudioBuf;
  if (opts.dubMusic) {
    const sourceAudio = await extractAudioWav(path.join(dir, videoName));
    dubAudioBuf = await synthesizeDubOverMusic(
      opts.dubMusic.cues,
      opts.dubMusic.target,
      sourceAudio,
    );
  }

  let dubName: string | undefined;
  if (dubAudioBuf) {
    dubName = "dub.wav";
    await writeFile(path.join(dir, dubName), dubAudioBuf);
  }

  // Trim goes AFTER -i (output-referenced seeking) rather than before: it's
  // slower (decodes from the start and discards) but avoids keyframe-boundary
  // drift, which matters here since the point is captions lining up exactly.
  // avoid_negative_ts keeps the trimmed output's PTS starting cleanly at 0,
  // matching the caller's already-rebased SRT.
  //
  // Only needed for an uploaded buffer, which is always the full original —
  // a URL source with a range was already trimmed to exactly that section by
  // downloadVideoClip (via yt-dlp --download-sections), so re-applying -ss/-to
  // here would double-trim an already-short clip.
  const needsFfmpegTrim = ranged && !!opts.videoBuf;
  const trimArgs = needsFfmpegTrim
    ? ["-ss", String(opts.startSec), "-to", String(opts.endSec), "-avoid_negative_ts", "make_zero"]
    : [];

  // dub.wav was built against the same absolute timeline as the video (and
  // as subs.srt/the trim range), so a single output-level trimArgs — applied
  // once here, after both -i's — cuts both streams to the same window.
  const dubInputArgs = dubName ? ["-i", dubName] : [];
  const mapArgs = dubName ? ["-map", "0:v", "-map", "1:a"] : [];
  const vfArgs = burnCaptions ? ["-vf", `subtitles=subs.srt:${FORCE_STYLE}`] : [];
  // The dub track is padded ~1s past the last cue's end (see the sidecar's
  // /dub), which can run slightly longer than the video — bound the output
  // to the video's own length so the picture doesn't freeze on a trailing
  // audio-only tail.
  const shortestArgs = dubName ? ["-shortest"] : [];

  await runFfmpeg(
    [
      "-i",
      videoName,
      ...dubInputArgs,
      ...trimArgs,
      ...mapArgs,
      ...vfArgs,
      ...shortestArgs,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      "-y",
      "out.mp4",
    ],
    dir,
  );

  return { outPath: path.join(dir, "out.mp4"), dir };
}
