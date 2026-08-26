// Minimal SRT/VTT parsing + serialization. Timestamps are preserved exactly;
// only the cue text is translated.

export interface Cue {
  index: number;
  start: string; // raw timestamp as written in the source format
  end: string;
  text: string; // may contain newlines
}

export type Format = "srt" | "vtt";

export function detectFormat(filename: string, content: string): Format {
  if (filename.toLowerCase().endsWith(".vtt")) return "vtt";
  if (filename.toLowerCase().endsWith(".srt")) return "srt";
  return content.trimStart().toUpperCase().startsWith("WEBVTT") ? "vtt" : "srt";
}

const TIME_LINE = /(\d{1,2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{3})/;

export function parseSubtitles(content: string): Cue[] {
  const normalized = content.replace(/\r\n/g, "\n").replace(/^﻿/, "");
  const blocks = normalized.split(/\n\s*\n/);
  const cues: Cue[] = [];
  let autoIndex = 1;

  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;
    if (lines[0].trim().toUpperCase().startsWith("WEBVTT")) continue;

    let i = 0;
    // Optional numeric/identifier line before the timestamp.
    if (!TIME_LINE.test(lines[i]) && lines[i + 1] && TIME_LINE.test(lines[i + 1])) {
      i += 1;
    }
    const m = lines[i]?.match(TIME_LINE);
    if (!m) continue;

    const text = lines.slice(i + 1).join("\n");
    cues.push({ index: autoIndex++, start: m[1], end: m[2], text });
  }
  return cues;
}

/** Parse a "HH:MM:SS,mmm" or "HH:MM:SS.mmm" timestamp to seconds. */
export function parseTimeToSeconds(stamp: string): number {
  const m = stamp.match(/(\d+):(\d{2}):(\d{2})[.,](\d{3})/);
  if (!m) return 0;
  const [, h, mi, s, ms] = m;
  return Number(h) * 3600 + Number(mi) * 60 + Number(s) + Number(ms) / 1000;
}

/** Format seconds as an SRT-style "HH:MM:SS,mmm" timestamp. */
export function secondsToTimestamp(sec: number): string {
  if (sec < 0 || Number.isNaN(sec)) sec = 0;
  const ms = Math.round((sec % 1) * 1000);
  const s = Math.floor(sec) % 60;
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
}

function toSrtTime(t: string): string {
  return t.replace(".", ",");
}
function toVttTime(t: string): string {
  return t.replace(",", ".");
}

export function serialize(cues: Cue[], format: Format): string {
  if (format === "vtt") {
    const body = cues
      .map(
        (c) =>
          `${c.index}\n${toVttTime(c.start)} --> ${toVttTime(c.end)}\n${c.text}`,
      )
      .join("\n\n");
    return `WEBVTT\n\n${body}\n`;
  }
  return (
    cues
      .map(
        (c) =>
          `${c.index}\n${toSrtTime(c.start)} --> ${toSrtTime(c.end)}\n${c.text}`,
      )
      .join("\n\n") + "\n"
  );
}

export function download(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
