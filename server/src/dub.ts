import type { AsrCue } from "./asr.js";
import { stampToSec } from "./asr.js";

/**
 * Synthesize one dubbed audio track (WAV) covering all cues, via the Python
 * sidecar's Meta MMS-TTS voices. MMS is the only broadly available open TTS
 * with real Kinyarwanda coverage (Coqui/XTTS has none), so it's used for
 * every target language here, not just Kinyarwanda.
 */
export async function synthesizeDub(cues: AsrCue[], target: string): Promise<Buffer> {
  const baseUrl = process.env.MBAZA_URL ?? "http://localhost:8000";
  const body = {
    cues: cues.map((c) => ({
      text: c.text,
      start: stampToSec(c.start),
      end: stampToSec(c.end),
    })),
    target,
  };
  const r = await fetch(`${baseUrl}/dub`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  if (!r.ok) {
    const detail: any = await r.json().catch(() => ({}));
    throw new Error(detail?.detail ?? `Dubbing sidecar error ${r.status}`);
  }
  return Buffer.from(await r.arrayBuffer());
}
