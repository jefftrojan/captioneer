import type { AsrCue } from "./asr.js";

const TIME =
  /(\d{1,2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{3})/;

/**
 * Parse SRT or VTT into cues. Built to survive YouTube auto-captions, which
 * are messy: inline timing tags (<00:00:01.000><c>…</c>) and heavy duplication
 * from the "rolling" caption effect.
 */
export function parseSubtitles(content: string): AsrCue[] {
  const norm = content.replace(/\r\n/g, "\n").replace(/^﻿/, "");
  const blocks = norm.split(/\n\s*\n/);
  const cues: AsrCue[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (!lines.length) continue;
    if (lines[0].trim().toUpperCase().startsWith("WEBVTT")) continue;

    let i = 0;
    if (!TIME.test(lines[i]) && lines[i + 1] && TIME.test(lines[i + 1])) i += 1;
    const m = lines[i]?.match(TIME);
    if (!m) continue;

    const text = lines
      .slice(i + 1)
      .join("\n")
      .replace(/<[^>]+>/g, "") // strip inline VTT timing/style tags
      .replace(/&nbsp;/g, " ")
      .trim();
    if (!text) continue;

    cues.push({
      index: 0,
      start: m[1].replace(".", ","),
      end: m[2].replace(".", ","),
      text,
    });
  }

  // Collapse consecutive duplicate lines (YouTube auto-sub rolling effect).
  const out: AsrCue[] = [];
  for (const c of cues) {
    const prev = out[out.length - 1];
    if (prev && prev.text === c.text) {
      prev.end = c.end;
      continue;
    }
    out.push(c);
  }
  out.forEach((c, i) => (c.index = i + 1));
  return out;
}
