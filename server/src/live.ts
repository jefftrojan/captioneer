import type { IncomingMessage } from "node:http";
import WebSocket from "ws";
import { shiftCueTimes, transcribe, transcribeKinyarwanda } from "./asr.js";

// Whisper (local or the Kinyarwanda sidecar) isn't a streaming architecture —
// it needs a finished clip. "Live" here means: the client restarts its
// MediaRecorder every ~LIVE_WINDOW_SECONDS, so each message we get is one
// complete, independently-decodable clip we can run through the exact same
// transcribe()/transcribeKinyarwanda() used for uploads, then stitch onto a
// running timeline.
const LIVE_WINDOW_SECONDS = 4;

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export function handleLiveConnection(ws: WebSocket, req: IncomingMessage) {
  const url = new URL(req.url ?? "", "http://internal");
  const language = url.searchParams.get("language") || "english";

  let windowIndex = 0;
  // Processed strictly in order, one at a time: a slow window (esp.
  // Kinyarwanda on the CPU sidecar) should add latency, never race the next.
  let queue = Promise.resolve();

  ws.on("message", (data, isBinary) => {
    if (!isBinary) return;
    const buf = toBuffer(data);
    queue = queue.then(async () => {
      const offsetSec = windowIndex * LIVE_WINDOW_SECONDS;
      windowIndex += 1;
      try {
        const cues =
          language === "kinyarwanda"
            ? await transcribeKinyarwanda(buf)
            : await transcribe(buf, language);
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: "cues", cues: shiftCueTimes(cues, offsetSec) }));
      } catch (err: any) {
        console.error("[live] window failed:", err);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "error", message: err?.message ?? "Transcription failed" }));
        }
      }
    });
  });
}
