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
}): Promise<BurnResult> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "captioneer-burn-"));

  let videoName: string;
  if (opts.videoBuf) {
    videoName = "in.mp4";
    await writeFile(path.join(dir, videoName), opts.videoBuf);
  } else if (opts.url) {
    videoName = path.basename(await downloadVideoClip(dir, opts.url));
  } else {
    throw new Error("No video provided to burn captions into.");
  }

  await writeFile(path.join(dir, "subs.srt"), opts.srt, "utf8");

  await runFfmpeg(
    [
      "-i",
      videoName,
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
