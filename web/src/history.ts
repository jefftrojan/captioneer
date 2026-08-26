// Lightweight session history, persisted to localStorage. No backend, no
// auth — just "remember recent sessions on this browser" so Home/Videos/
// Channels/Render aren't permanently empty after every reload.
import type { Cue } from "./subtitles";

export type SourceType = "file" | "video" | "url" | "live";

export interface HistoryEntry {
  id: string;
  timestamp: number;
  source: SourceType;
  title: string;
  sourceLang: string;
  targetLang: string;
  engine: string;
  cueCount: number;
  translatedCount: number;
  rendered: boolean;
  cues: Cue[];
  translations: string[];
  /** Only set for source === "url" — the original link, kept so a URL-sourced
   * session can be re-fetched/re-burned later without the video file itself
   * (which is never persisted, unlike a plain string). */
  sourceUrl?: string;
}

const KEY = "captioneer:history";
const MAX_ENTRIES = 50;

function readAll(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(entries: HistoryEntry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // localStorage full or unavailable (e.g. private browsing) -- history
    // just won't persist this run, nothing else depends on it succeeding.
  }
}

export function loadHistory(): HistoryEntry[] {
  return readAll();
}

export function saveEntry(entry: Omit<HistoryEntry, "id" | "timestamp">): HistoryEntry {
  const full: HistoryEntry = { ...entry, id: crypto.randomUUID(), timestamp: Date.now() };
  writeAll([full, ...readAll()]);
  return full;
}

export function updateEntry(id: string, patch: Partial<HistoryEntry>): void {
  writeAll(readAll().map((e) => (e.id === id ? { ...e, ...patch } : e)));
}

export function markRendered(id: string): void {
  updateEntry(id, { rendered: true });
}
