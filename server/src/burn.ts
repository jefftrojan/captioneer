import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { downloadVideoClip } from "./urlfetch.js";

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
}): Promise<BurnResult> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "captioneer-burn-"));
  const ranged = opts.startSec != null && opts.endSec != null;

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

  await writeFile(path.join(dir, "subs.srt"), opts.srt, "utf8");

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

  await runFfmpeg(
    [
      "-i",
      videoName,
      ...trimArgs,
      "-vf",
      `subtitles=subs.srt:${FORCE_STYLE}`,
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
