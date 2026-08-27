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

/**
 * Music-video dubbing: separates the source audio into vocals/instrumental
 * (Demucs, in the sidecar) and mixes translated narration on top of the kept
 * instrumental, instead of the plain /dub path's narration-replaces-everything.
 * This is NOT sung dubbing — no melody/pitch synthesis, just narration over
 * the original music bed. `audioWav` is the extracted source audio (any
 * format ffmpeg can decode; the sidecar re-decodes it via torchaudio).
 *
 * Separation is genuinely slow on this CPU-only sidecar (~6-7x real-time
 * measured with htdemucs) — a 3-4min song can take 20-30min. The timeout
 * here is sized for that, not for responsiveness.
 */
export async function synthesizeDubOverMusic(
  cues: AsrCue[],
  target: string,
  audioWav: Buffer,
): Promise<Buffer> {
  const baseUrl = process.env.MBAZA_URL ?? "http://localhost:8000";
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audioWav)], { type: "audio/wav" }), "audio.wav");
  form.append(
    "cues",
    JSON.stringify(
      cues.map((c) => ({
        text: c.text,
        start: stampToSec(c.start),
        end: stampToSec(c.end),
      })),
    ),
  );
  form.append("target", target);
  const r = await fetch(`${baseUrl}/dub-music`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(2_400_000),
  });
  if (!r.ok) {
    const detail: any = await r.json().catch(() => ({}));
    throw new Error(detail?.detail ?? `Music dubbing sidecar error ${r.status}`);
  }
  return Buffer.from(await r.arrayBuffer());
}
