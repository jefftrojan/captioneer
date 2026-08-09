import type { TranslateRequest, TranslationEngine } from "./types.js";

/**
 * "Rwanda-local" engine: a Digital Umuganda / mbazaNLP NLLB finetune, run by
 * the Python inference sidecar (inference-py). This lets the demo compare a
 * global model (NLLB-200) against a Kinyarwanda-specialist model side by side.
 *
 * The sidecar loads MBAZA_MODEL with the HF token. The engine is "available"
 * only when the sidecar answers its health check, so the app still works fully
 * offline on NLLB when the sidecar isn't running.
 */
class MbazaEngine implements TranslationEngine {
  id = "mbaza";
  label = "Digital Umuganda / Mbaza";
  origin = "Kinyarwanda-finetuned NLLB, run locally via the Python sidecar";

  private get baseUrl() {
    return process.env.MBAZA_URL ?? "http://localhost:8000";
  }

  async isAvailable(): Promise<boolean> {
    try {
      const r = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (!r.ok) return false;
      const data: any = await r.json();
      return Boolean(data?.translate_ready ?? data?.ok);
    } catch {
      return false;
    }
  }

  async warmup(): Promise<void> {
    // The sidecar warms its own model on startup.
  }

  async translate({ texts, source, target }: TranslateRequest): Promise<string[]> {
    // One cue per request: the 1.3B model is ~45s/sentence on CPU, so a whole
    // file in a single request would blow past fetch's header timeout. Per-cue
    // requests keep each well within limits (and fail isolated, not all-or-nothing).
    const out: string[] = [];
    for (const text of texts) {
      const r = await fetch(`${this.baseUrl}/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts: [text], source, target }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!r.ok) {
        throw new Error(`Mbaza sidecar error ${r.status}: ${await r.text()}`);
      }
      const data: any = await r.json();
      if (data.error) throw new Error(data.error);
      out.push((data.translations as string[])[0]);
    }
    return out;
  }
}

export const mbazaEngine = new MbazaEngine();
