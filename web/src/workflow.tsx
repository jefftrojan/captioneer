import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  type Cue,
  type Format,
  download,
  parseSubtitles,
  parseTimeToSeconds,
  secondsToTimestamp,
  serialize,
} from "./subtitles";
import {
  type EngineInfo,
  type Language,
  type LiveMessage,
  burnVideo,
  fetchFromUrl,
  getEngines,
  getHealth,
  openLiveSocket,
  transcribe,
  translate,
} from "./api";
import {
  type HistoryEntry,
  type SourceType,
  markRendered,
  saveEntry,
  updateEntry,
} from "./history";

// How long each rolling mic recording runs before it's sent off to be
// transcribed and a fresh one starts. Whisper needs a finished clip, so this
// is the latency floor for "live" captions — smaller windows feel more live
// but cost more per-window overhead and short-utterance accuracy.
const LIVE_WINDOW_MS = 4000;

const SAMPLE = `1
00:00:01,000 --> 00:00:03,500
Welcome to Captioneer.

2
00:00:03,800 --> 00:00:07,000
This tool translates captions between
English and Kinyarwanda.

3
00:00:07,400 --> 00:00:10,000
The timing stays exactly the same.
`;

export type Page = "home" | "create" | "editor" | "videos" | "channels";
export type IntakeMode = "file" | "video" | "url" | "live";

interface WorkflowState {
  page: Page;
  navigate: (p: Page) => void;

  engines: EngineInfo[];
  languages: Language[];
  engine: string;
  setEngine: (id: string) => void;
  source: string;
  target: string;
  setSource: (c: string) => void;
  setTarget: (c: string) => void;
  swap: () => void;
  editCueText: (index: number, text: string) => void;
  editTranslation: (index: number, text: string) => void;
  modelReady: boolean;
  asrReady: boolean;

  intakeMode: IntakeMode;
  setIntakeMode: (m: IntakeMode) => void;
  filename: string;
  videoLang: string;
  setVideoLang: (l: string) => void;
  url: string;
  setUrl: (u: string) => void;
  fetching: boolean;
  urlNote: string | null;
  videoFile: File | null;
  transcribing: boolean;
  live: boolean;
  onFile: (file: File) => Promise<void>;
  onVideo: (file: File) => Promise<void>;
  onFetchUrl: () => Promise<void>;
  loadSample: () => void;
  startLive: () => Promise<void>;
  stopLive: () => void;

  cues: Cue[];
  translations: string[];
  translatedCues: Cue[];
  busy: boolean;
  progress: { done: number; total: number };
  translatingIndex: number | null;
  etaSeconds: number | null;
  runTranslate: () => Promise<void>;
  cancelTranslate: () => void;
  estimatedSlow: boolean;
  doDownload: (fmt: Format) => void;
  hasOutput: boolean;
  canTranslate: boolean;
  hasVideoSource: boolean;
  rangeStart: number | null;
  rangeEnd: number | null;
  setRangeStart: (sec: number | null) => void;
  setRangeEnd: (sec: number | null) => void;
  clearRange: () => void;

  burning: boolean;
  burnHandler: () => Promise<void>;

  error: string | null;
  setError: (e: string | null) => void;
  langName: (code: string) => string;
  activeEngine: EngineInfo | undefined;

  currentEntry: HistoryEntry | null;
  openHistoryEntry: (entry: HistoryEntry) => void;
}

const WorkflowContext = createContext<WorkflowState | null>(null);

export function useWorkflow(): WorkflowState {
  const ctx = useContext(WorkflowContext);
  if (!ctx) throw new Error("useWorkflow must be used inside WorkflowProvider");
  return ctx;
}

export function WorkflowProvider({ children }: { children: ReactNode }) {
  const [page, setPage] = useState<Page>("home");

  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [languages, setLanguages] = useState<Language[]>([]);
  const [engine, setEngine] = useState("nllb");
  const [source, setSource] = useState("eng_Latn");
  const [target, setTarget] = useState("kin_Latn");

  const [intakeMode, setIntakeModeState] = useState<IntakeMode>("file");
  const [filename, setFilename] = useState("captions.srt");
  const [videoLang, setVideoLang] = useState("english");
  const [url, setUrl] = useState("");
  const [fetching, setFetching] = useState(false);
  const [urlNote, setUrlNote] = useState<string | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [burning, setBurning] = useState(false);
  const [live, setLive] = useState(false);
  const liveStopRef = useRef<(() => void) | null>(null);
  const [cues, setCues] = useState<Cue[]>([]);
  const [translations, setTranslations] = useState<string[]>([]);
  const [currentEntry, setCurrentEntry] = useState<HistoryEntry | null>(null);

  const [modelReady, setModelReady] = useState(false);
  const [asrReady, setAsrReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getEngines()
      .then((d) => {
        setEngines(d.engines);
        setLanguages(d.languages);
      })
      .catch(() => setError("Could not reach the Captioneer server."));
  }, []);

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const h = await getHealth();
        if (!stop) {
          setModelReady(h.modelReady);
          setAsrReady(h.asrReady);
        }
        if ((!h.modelReady || !h.asrReady) && !stop) setTimeout(poll, 1500);
      } catch {
        if (!stop) setTimeout(poll, 2000);
      }
    };
    poll();
    return () => {
      stop = true;
    };
  }, []);

  const navigate = (p: Page) => setPage(p);

  function commitEntry(
    sourceType: SourceType,
    title: string,
    cuesForEntry: Cue[],
    sourceUrl?: string,
  ) {
    if (cuesForEntry.length === 0) return;
    const entry = saveEntry({
      source: sourceType,
      title,
      sourceLang: source,
      targetLang: target,
      engine,
      cueCount: cuesForEntry.length,
      translatedCount: 0,
      rendered: false,
      cues: cuesForEntry,
      translations: [],
      sourceUrl,
    });
    setCurrentEntry(entry);
  }

  const loadText = (name: string, content: string) => {
    setFilename(name);
    const parsed = parseSubtitles(content);
    setCues(parsed);
    setTranslations([]);
    setProgress({ done: 0, total: 0 });
    setVideoFile(null);
    setError(null);
    commitEntry("file", name, parsed);
    setPage("editor");
  };

  const onFile = async (file: File) => loadText(file.name, await file.text());
  const loadSample = () => loadText("sample.srt", SAMPLE);

  const onVideo = async (file: File) => {
    setTranscribing(true);
    setError(null);
    setTranslations([]);
    setCues([]);
    try {
      const asrCues = await transcribe(file, videoLang);
      const name = file.name.replace(/\.[^.]+$/, "") + ".srt";
      setFilename(name);
      setCues(asrCues);
      setVideoFile(file);
      if (asrCues.length === 0) {
        setError("No speech detected in that file.");
      } else {
        commitEntry("video", name, asrCues);
        setPage("editor");
      }
    } catch (e: any) {
      setError(e.message ?? "Transcription failed");
    } finally {
      setTranscribing(false);
    }
  };

  const onFetchUrl = async () => {
    if (!url.trim()) return;
    setFetching(true);
    setError(null);
    setUrlNote(null);
    setTranslations([]);
    setCues([]);
    setVideoFile(null);
    try {
      const res = await fetchFromUrl(url.trim(), videoLang);
      const safe = res.title.replace(/[^\w.-]+/g, "_").slice(0, 60) || "video";
      const name = `${safe}.srt`;
      setFilename(name);
      setCues(res.cues);
      setUrlNote(
        res.sourceUsed === "subtitles"
          ? `Loaded existing captions for "${res.title}".`
          : `No captions found — transcribed the first ${Math.round(180 / 60)} min of audio.`,
      );
      if (res.cues.length === 0) {
        setError("Nothing to caption from that URL.");
      } else {
        commitEntry("url", res.title, res.cues, url.trim());
        setPage("editor");
      }
    } catch (e: any) {
      setError(e.message ?? "Could not fetch that URL");
    } finally {
      setFetching(false);
    }
  };

  const appendLiveCues = (newCues: Cue[]) => {
    setCues((prev) => {
      const merged = [...prev, ...newCues];
      merged.forEach((c, i) => (c.index = i + 1));
      return merged;
    });
  };

  const startLive = async () => {
    if (live) return;
    setError(null);
    setUrlNote(null);
    setTranslations([]);
    setCues([]);
    setVideoFile(null);
    const title = "Live session";
    setFilename("live.srt");

    if (!navigator.mediaDevices?.getUserMedia) {
      setError(
        "Microphone access isn't available here (needs https:// or localhost).",
      );
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("Microphone permission was denied.");
      return;
    }

    const ws = openLiveSocket(videoLang);
    let active = true;
    let recorder: MediaRecorder | null = null;
    let windowTimer: ReturnType<typeof setTimeout> | null = null;

    const stop = () => {
      if (!active) return;
      active = false;
      if (windowTimer) clearTimeout(windowTimer);
      if (recorder && recorder.state === "recording") recorder.stop();
      stream.getTracks().forEach((t) => t.stop());
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      liveStopRef.current = null;
      setLive(false);
      setCues((prev) => {
        commitEntry("live", title, prev);
        if (prev.length > 0) setPage("editor");
        return prev;
      });
    };
    liveStopRef.current = stop;

    // MediaRecorder can't be paused-and-resumed into separate decodable
    // clips, so each ~4s window is its own record-then-stop cycle on the
    // same stream — every stop() yields one complete, independently
    // decodable blob the server can hand straight to ffmpeg.
    const startWindow = () => {
      if (!active) return;
      const chunks: BlobPart[] = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      recorder.onstop = async () => {
        if (chunks.length && ws.readyState === WebSocket.OPEN) {
          const buf = await new Blob(chunks).arrayBuffer();
          ws.send(buf);
        }
        if (active) startWindow();
      };
      recorder.start();
      windowTimer = setTimeout(() => {
        if (recorder && recorder.state === "recording") recorder.stop();
      }, LIVE_WINDOW_MS);
    };

    ws.onopen = () => {
      setLive(true);
      startWindow();
    };
    ws.onmessage = (ev) => {
      try {
        const msg: LiveMessage = JSON.parse(ev.data);
        if (msg.type === "cues") appendLiveCues(msg.cues);
        else if (msg.type === "error") setError(msg.message);
      } catch {
        /* ignore malformed message */
      }
    };
    ws.onerror = () => {
      setError("Live connection failed.");
      stop();
    };
    ws.onclose = stop;
  };

  const stopLive = () => liveStopRef.current?.();

  // Stop any live recording if the page is left mid-session.
  useEffect(() => () => liveStopRef.current?.(), []);

  const setIntakeMode = (m: IntakeMode) => {
    if (live) stopLive();
    setIntakeModeState(m);
  };

  const swap = () => {
    setSource(target);
    setTarget(source);
    setTranslations([]);
  };

  const editCueText = (index: number, text: string) => {
    setCues((prev) => {
      const next = prev.map((c, i) => (i === index ? { ...c, text } : c));
      if (currentEntry) updateEntry(currentEntry.id, { cues: next });
      return next;
    });
  };

  const editTranslation = (index: number, text: string) => {
    setTranslations((prev) => {
      const next = [...prev];
      next[index] = text;
      if (currentEntry) {
        updateEntry(currentEntry.id, {
          translations: next,
          translatedCount: next.filter(Boolean).length,
        });
      }
      return next;
    });
  };

  const [translatingIndex, setTranslatingIndex] = useState<number | null>(null);
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);
  const translateAbortRef = useRef<AbortController | null>(null);

  const runTranslate = async () => {
    setBusy(true);
    setError(null);
    setProgress({ done: 0, total: cues.length });
    setTranslatingIndex(0);
    setEtaSeconds(null);
    const results: string[] = new Array(cues.length).fill("");
    setTranslations([...results]);
    const controller = new AbortController();
    translateAbortRef.current = controller;
    // Translate in small batches so cues fill in live (and the slow Digital
    // Umuganda 1.3B model shows real progress instead of a frozen spinner).
    const batch = engine === "mbaza" ? 1 : 4;
    const startedAt = Date.now();
    try {
      for (let i = 0; i < cues.length; i += batch) {
        if (controller.signal.aborted) break;
        setTranslatingIndex(i);
        const slice = cues.slice(i, i + batch);
        const out = await translate(
          slice.map((c) => c.text),
          source,
          target,
          engine,
          controller.signal,
        );
        out.forEach((t, k) => (results[i + k] = t));
        setTranslations([...results]);
        const done = Math.min(i + batch, cues.length);
        setProgress({ done, total: cues.length });
        const elapsedSec = (Date.now() - startedAt) / 1000;
        const remaining = cues.length - done;
        setEtaSeconds(remaining > 0 ? Math.round((elapsedSec / done) * remaining) : 0);
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") setError(e.message ?? "Translation failed");
    } finally {
      if (currentEntry) {
        updateEntry(currentEntry.id, {
          translatedCount: results.filter(Boolean).length,
          translations: results,
        });
      }
      setBusy(false);
      setTranslatingIndex(null);
      setEtaSeconds(null);
      translateAbortRef.current = null;
    }
  };

  const cancelTranslate = () => {
    translateAbortRef.current?.abort();
  };

  const estimatedSlow = engine === "mbaza" && cues.length > 30;

  const translatedCues = useMemo<Cue[]>(
    () => cues.map((c, i) => ({ ...c, text: translations[i] || c.text })),
    [cues, translations],
  );

  const [rangeStart, setRangeStart] = useState<number | null>(null);
  const [rangeEnd, setRangeEnd] = useState<number | null>(null);
  const clearRange = () => {
    setRangeStart(null);
    setRangeEnd(null);
  };

  // Two different notions of "ranged cues", confirmed by actually burning a
  // test clip and checking the output frames:
  //  - A standalone clip's caption FILE should start at 0:00, not wherever
  //    the range began (rebase: true) — for the plain .srt/.vtt export.
  //  - ffmpeg's `subtitles` filter times cues against the ORIGINAL, pre-trim
  //    input timeline even when the output itself is trimmed with -ss/-to —
  //    rebased timestamps land on footage that gets discarded and the text
  //    never appears. So the SRT sent along with a burn must keep the
  //    original absolute timestamps (rebase: false).
  function rangedCues(rebase: boolean): Cue[] {
    if (rangeStart == null || rangeEnd == null) return translatedCues;
    const filtered = translatedCues.filter((c) => {
      const s = parseTimeToSeconds(c.start);
      return s >= rangeStart && s < rangeEnd;
    });
    if (!rebase) return filtered.map((c, i) => ({ ...c, index: i + 1 }));
    return filtered.map((c, i) => ({
      ...c,
      index: i + 1,
      start: secondsToTimestamp(parseTimeToSeconds(c.start) - rangeStart),
      end: secondsToTimestamp(parseTimeToSeconds(c.end) - rangeStart),
    }));
  }

  const doDownload = (fmt: Format) => {
    const base = filename.replace(/\.(srt|vtt)$/i, "");
    const suffix = rangeStart != null && rangeEnd != null ? ".clip" : "";
    download(`${base}.${target.split("_")[0]}${suffix}.${fmt}`, serialize(rangedCues(true), fmt));
  };

  const hasVideoSource = !!videoFile || (intakeMode === "url" && !!url.trim());

  const burnHandler = async () => {
    setBurning(true);
    setError(null);
    try {
      const ranged = rangeStart != null && rangeEnd != null;
      // For an uploaded file, the server trims with ffmpeg -ss/-to against
      // the ORIGINAL full file, so the subtitles filter needs absolute
      // timestamps (confirmed empirically — rebased ones land on discarded
      // footage and never render). For a URL, the server pre-trims to just
      // that section via yt-dlp before ffmpeg ever sees it, so the SRT must
      // be rebased to match that already-0-based clip instead.
      const srt = serialize(rangedCues(intakeMode === "url"), "srt");
      const blob = await burnVideo({
        srt,
        file: videoFile ?? undefined,
        url: intakeMode === "url" ? url.trim() : undefined,
        startSec: ranged ? rangeStart! : undefined,
        endSec: ranged ? rangeEnd! : undefined,
      });
      const base = filename.replace(/\.(srt|vtt)$/i, "");
      const suffix = ranged ? ".clip" : "";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${base}.${target.split("_")[0]}${suffix}.captioned.mp4`;
      a.click();
      URL.revokeObjectURL(a.href);
      if (currentEntry) {
        markRendered(currentEntry.id);
        setCurrentEntry({ ...currentEntry, rendered: true });
      }
    } catch (e: any) {
      setError(e.message ?? "Could not render the video");
    } finally {
      setBurning(false);
    }
  };

  const openHistoryEntry = (entry: HistoryEntry) => {
    setCurrentEntry(entry);
    setFilename(entry.title);
    setCues(entry.cues);
    setTranslations(entry.translations);
    setSource(entry.sourceLang);
    setTarget(entry.targetLang);
    setEngine(entry.engine);
    setVideoFile(null);
    // The video/audio file itself is never persisted (only URLs are cheap
    // enough to keep) — a reopened file/video/live session has no way to
    // burn-in again until you supply a source, which is the honest state.
    setUrl(entry.sourceUrl ?? "");
    setIntakeModeState(entry.source);
    setError(null);
    setPage("editor");
  };

  const langName = (code: string) =>
    languages.find((l) => l.code === code)?.name ?? code;
  const activeEngine = engines.find((e) => e.id === engine);
  const hasOutput = translations.some((t) => t);
  const canTranslate = cues.length > 0 && !busy && (engine !== "nllb" || modelReady);

  const value: WorkflowState = {
    page,
    navigate,
    engines,
    languages,
    engine,
    setEngine,
    source,
    target,
    setSource,
    setTarget,
    swap,
    editCueText,
    editTranslation,
    modelReady,
    asrReady,
    intakeMode,
    setIntakeMode,
    filename,
    videoLang,
    setVideoLang,
    url,
    setUrl,
    fetching,
    urlNote,
    videoFile,
    transcribing,
    live,
    onFile,
    onVideo,
    onFetchUrl,
    loadSample,
    startLive,
    stopLive,
    cues,
    translations,
    translatedCues,
    busy,
    progress,
    translatingIndex,
    etaSeconds,
    runTranslate,
    cancelTranslate,
    estimatedSlow,
    doDownload,
    hasOutput,
    canTranslate,
    hasVideoSource,
    rangeStart,
    rangeEnd,
    setRangeStart,
    setRangeEnd,
    clearRange,
    burning,
    burnHandler,
    error,
    setError,
    langName,
    activeEngine,
    currentEntry,
    openHistoryEntry,
  };

  return <WorkflowContext.Provider value={value}>{children}</WorkflowContext.Provider>;
}
