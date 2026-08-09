import type { TranslationEngine } from "./types.js";
import { nllbEngine } from "./nllb.js";
import { mbazaEngine } from "./mbaza.js";

const engines: TranslationEngine[] = [nllbEngine, mbazaEngine];

export function getEngine(id: string | undefined): TranslationEngine {
  if (!id) return nllbEngine;
  const found = engines.find((e) => e.id === id);
  if (!found) throw new Error(`Unknown engine: ${id}`);
  return found;
}

export async function listEngines() {
  return Promise.all(
    engines.map(async (e) => ({
      id: e.id,
      label: e.label,
      origin: e.origin,
      available: await e.isAvailable(),
    })),
  );
}

export const defaultEngine = nllbEngine;
