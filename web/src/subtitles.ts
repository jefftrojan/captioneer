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
