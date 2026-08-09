import {
  pipeline,
  type TranslationPipeline,
} from "@huggingface/transformers";
import type { TranslateRequest, TranslationEngine } from "./types.js";

const MODEL_ID = "Xenova/nllb-200-distilled-600M";

/**
 * Meta's NLLB-200 (distilled, 600M) running on-device via transformers.js /
 * ONNX Runtime. No Python, no network at inference time once the model is
 * cached. Supports all 200 FLORES languages, including Kinyarwanda (kin_Latn).
 */
class NllbEngine implements TranslationEngine {
  id = "nllb";
  label = "NLLB-200 (600M)";
  origin = "Meta — runs locally via ONNX, 200 languages incl. Kinyarwanda";

  private translator: Promise<TranslationPipeline> | null = null;

  private load(): Promise<TranslationPipeline> {
    if (!this.translator) {
      console.log(`[nllb] loading ${MODEL_ID} (first run downloads weights)…`);
      this.translator = pipeline("translation", MODEL_ID, {
        // 8-bit quantized keeps memory modest on a 16GB laptop.
        dtype: "q8",
      }) as Promise<TranslationPipeline>;
    }
    return this.translator;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async warmup(): Promise<void> {
    const t = await this.load();
    // A tiny translation forces graph compilation so the first real call is fast.
    await t("Hello", { src_lang: "eng_Latn", tgt_lang: "kin_Latn" } as any);
    console.log("[nllb] ready");
  }

  async translate({ texts, source, target }: TranslateRequest): Promise<string[]> {
    const t = await this.load();
    // Translate one cue at a time: batching pads short sentences to the same
    // length, which makes NLLB-600M hallucinate trailing junk. Subtitle cues
    // are short, so sequential calls keep quality clean at acceptable speed.
    const out: string[] = [];
    for (const text of texts) {
      const r = (await t(text, {
        src_lang: source,
        tgt_lang: target,
        // Greedy decoding: NLLB's config defaults to multi-beam search, which is
        // several times slower on CPU for no real subtitle-quality gain.
        num_beams: 1,
        do_sample: false,
        max_new_tokens: 200,
      } as any)) as Array<{ translation_text: string }>;
      out.push(r[0]?.translation_text ?? "");
    }
    return out;
  }
}

export const nllbEngine = new NllbEngine();
