// FLORES-200 language codes used by NLLB. We keep the demo focused on
// English <-> Kinyarwanda but the type allows any FLORES code.
export type LangCode = string;

export interface TranslateRequest {
  texts: string[];
  source: LangCode;
  target: LangCode;
}

export interface TranslationEngine {
  /** Stable id used by the API/UI to select the engine. */
  id: string;
  /** Human-friendly name shown in the UI. */
  label: string;
  /** Short description of where the model comes from. */
  origin: string;
  /** Whether the engine is usable in the current environment. */
  isAvailable(): Promise<boolean>;
  /** Warm the model so the first real request is fast. */
  warmup(): Promise<void>;
  /** Translate a batch of strings. Must return one output per input. */
  translate(req: TranslateRequest): Promise<string[]>;
}

export const LANGUAGES: { code: LangCode; name: string }[] = [
  { code: "eng_Latn", name: "English" },
  { code: "kin_Latn", name: "Kinyarwanda" },
  { code: "fra_Latn", name: "French" },
  { code: "swh_Latn", name: "Swahili" },
];
