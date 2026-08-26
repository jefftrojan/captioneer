import { spawn } from "node:child_process";
import { pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import wavefilePkg from "wavefile";

const { WaveFile } = wavefilePkg as { WaveFile: typeof import("wavefile").WaveFile };

const ASR_MODEL = "Xenova/whisper-base";

export interface AsrCue {
  index: number;
  start: string;
  end: string;
  text: string;
}

let asr: Promise<AutomaticSpeechRecognitionPipeline> | null = null;
function loadAsr(): Promise<AutomaticSpeechRecognitionPipeline> {
  if (!asr) {
    console.log(`[asr] loading ${ASR_MODEL}…`);
    asr = pipeline("automatic-speech-recognition", ASR_MODEL, {
      dtype: "q8",
    }) as Promise<AutomaticSpeechRecognitionPipeline>;
  }
  return asr;
}

export async function warmupAsr() {
  await loadAsr();
  console.log("[asr] ready");
}

/** Decode any media buffer to 16kHz mono float32 PCM using ffmpeg. */
function decodeAudio(input: Buffer): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-i", "pipe:0",
      "-ar", "16000",
      "-ac", "1",
      "-f", "wav",
      "pipe:1",
    ]);
    const chunks: Buffer[] = [];
    const errs: Buffer[] = [];
    ff.stdout.on("data", (d) => chunks.push(d));
    ff.stderr.on("data", (d) => errs.push(d));
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code !== 0) {
        return reject(
          new Error(`ffmpeg exited ${code}: ${Buffer.concat(errs).toString().slice(-400)}`),
        );
      }
      const wav = new WaveFile(Buffer.concat(chunks));
      wav.toBitDepth("32f");
      const samples = wav.getSamples();
      const mono = Array.isArray(samples) ? samples[0] : samples;
      resolve(Float32Array.from(mono as Float32Array));
    });
    ff.stdin.write(input);
    ff.stdin.end();
  });
}

function secToStamp(sec: number): string {
  if (sec == null || isNaN(sec)) sec = 0;
  const ms = Math.floor((sec % 1) * 1000);
  const s = Math.floor(sec) % 60;
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
}

export function stampToSec(stamp: string): number {
  const m = stamp.match(/(\d+):(\d{2}):(\d{2})[.,](\d{3})/);
  if (!m) return 0;
  const [, h, mi, s, ms] = m;
  return Number(h) * 3600 + Number(mi) * 60 + Number(s) + Number(ms) / 1000;
}

/** Shift every cue's start/end forward by `offsetSec` (for stitching independently-transcribed windows into one running timeline). */
export function shiftCueTimes(cues: AsrCue[], offsetSec: number): AsrCue[] {
  return cues.map((c) => ({
    ...c,
    start: secToStamp(stampToSec(c.start) + offsetSec),
    end: secToStamp(stampToSec(c.end) + offsetSec),
  }));
}

function chunksToCues(
  chunks: Array<{ timestamp: [number, number | null]; text: string }>,
): AsrCue[] {
  const cues: AsrCue[] = [];
  let prevEnd = 0;
  chunks.forEach((c) => {
    const start = c.timestamp?.[0] ?? prevEnd;
    const end = c.timestamp?.[1] ?? start + 2;
    prevEnd = end;
    const text = (c.text ?? "").trim();
    if (text) {
      cues.push({ index: 0, start: secToStamp(start), end: secToStamp(end), text });
    }
  });
  cues.forEach((c, i) => (c.index = i + 1));
  return cues;
}

/** Transcribe a media buffer into timestamped cues with local Whisper. */
export async function transcribe(input: Buffer, language: string): Promise<AsrCue[]> {
  const audio = await decodeAudio(input);
  const model = await loadAsr();
  const result: any = await model(audio, {
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
    language: language || "english",
    task: "transcribe",
  });
  return chunksToCues(result.chunks ?? []);
}

/**
 * Transcribe Kinyarwanda speech via the Python sidecar (Digital Umuganda
 * Whisper finetune). We do the ffmpeg decode here and forward raw float32 PCM
 * so the sidecar image doesn't need ffmpeg.
 */
export async function transcribeKinyarwanda(input: Buffer): Promise<AsrCue[]> {
  const audio = await decodeAudio(input);
  const audioB64 = Buffer.from(
    audio.buffer,
    audio.byteOffset,
    audio.byteLength,
  ).toString("base64");
  const baseUrl = process.env.MBAZA_URL ?? "http://localhost:8000";
  const r = await fetch(`${baseUrl}/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audio_b64: audioB64, sampling_rate: 16000 }),
  });
  if (!r.ok) {
    throw new Error(`Mbaza ASR sidecar error ${r.status}: ${await r.text()}`);
  }
  const data: any = await r.json();
  if (data.error) throw new Error(data.error);
  return chunksToCues(data.chunks ?? []);
}
