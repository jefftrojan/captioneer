import { useEffect, useMemo, useRef, useState } from "react";
import Logo from "./Logo";
import {
  type Cue,
  type Format,
  download,
  parseSubtitles,
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

export default function App() {
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [languages, setLanguages] = useState<Language[]>([]);
  const [engine, setEngine] = useState("nllb");
  const [source, setSource] = useState("eng_Latn");
  const [target, setTarget] = useState("kin_Latn");

  const [mode, setMode] = useState<"file" | "video" | "url" | "live">("file");
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

  const [modelReady, setModelReady] = useState(false);
  const [asrReady, setAsrReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [transcribing, setTranscribing] = useState(false);
  const [dragging, setDragging] = useState(false);
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

  const loadText = (name: string, content: string) => {
    setFilename(name);
    setCues(parseSubtitles(content));
    setTranslations([]);
    setProgress({ done: 0, total: 0 });
    setVideoFile(null);
    setError(null);
  };

  const onFile = async (file: File) => loadText(file.name, await file.text());

  const onVideo = async (file: File) => {
    setTranscribing(true);
    setError(null);
    setTranslations([]);
    setCues([]);
    try {
      const asrCues = await transcribe(file, videoLang);
      setFilename(file.name.replace(/\.[^.]+$/, "") + ".srt");
      setCues(asrCues);
      setVideoFile(file);
      if (asrCues.length === 0) setError("No speech detected in that file.");
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
      setFilename(`${safe}.srt`);
      setCues(res.cues);
      setUrlNote(
        res.sourceUsed === "subtitles"
          ? `Loaded existing captions for “${res.title}”.`
          : `No captions found — transcribed the first ${Math.round(180 / 60)} min of audio.`,
      );
      if (res.cues.length === 0) setError("Nothing to caption from that URL.");
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

  const switchMode = (m: typeof mode) => {
    if (live) stopLive();
    setMode(m);
  };

  const handleDrop = (file: File) => (mode === "video" ? onVideo(file) : onFile(file));

  const swap = () => {
    setSource(target);
    setTarget(source);
    setTranslations([]);
  };

  const runTranslate = async () => {
    setBusy(true);
    setError(null);
    setProgress({ done: 0, total: cues.length });
    const results: string[] = new Array(cues.length).fill("");
    setTranslations([...results]);
    // Translate in small batches so cues fill in live (and the slow Digital
    // Umuganda 1.3B model shows real progress instead of a frozen spinner).
    const batch = engine === "mbaza" ? 1 : 4;
    try {
      for (let i = 0; i < cues.length; i += batch) {
        const slice = cues.slice(i, i + batch);
        const out = await translate(
          slice.map((c) => c.text),
          source,
          target,
          engine,
        );
        out.forEach((t, k) => (results[i + k] = t));
        setTranslations([...results]);
        setProgress({ done: Math.min(i + batch, cues.length), total: cues.length });
      }
    } catch (e: any) {
      setError(e.message ?? "Translation failed");
    } finally {
      setBusy(false);
    }
  };

  const translatedCues = useMemo<Cue[]>(
    () => cues.map((c, i) => ({ ...c, text: translations[i] || c.text })),
    [cues, translations],
  );

  const doDownload = (fmt: Format) => {
    const base = filename.replace(/\.(srt|vtt)$/i, "");
    download(`${base}.${target.split("_")[0]}.${fmt}`, serialize(translatedCues, fmt));
  };

  const hasVideoSource = !!videoFile || (mode === "url" && !!url.trim());

  const burnHandler = async () => {
    setBurning(true);
    setError(null);
    try {
      const blob = await burnVideo({
        srt: serialize(translatedCues, "srt"),
        file: videoFile ?? undefined,
        url: mode === "url" ? url.trim() : undefined,
      });
      const base = filename.replace(/\.(srt|vtt)$/i, "");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${base}.${target.split("_")[0]}.captioned.mp4`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e: any) {
      setError(e.message ?? "Could not render the video");
    } finally {
      setBurning(false);
    }
  };

  const langName = (code: string) =>
    languages.find((l) => l.code === code)?.name ?? code;
  const activeEngine = engines.find((e) => e.id === engine);
  const hasOutput = translations.some((t) => t);
  const canTranslate =
    cues.length > 0 && !busy && (engine !== "nllb" || modelReady);

  return (
    <div className="app">
      <header className="masthead">
        <div className="brand">
          <Logo />
          <div>
            <div className="wordmark">Captioneer</div>
            <p className="kicker">Bringing captions home.</p>
          </div>
        </div>
        <div className="locale">
          <b>Ikinyarwanda</b> · English
        </div>
      </header>

      <div className="workspace">
        {/* ---------------- intake panel ---------------- */}
        <section className="panel intake">
          <div className="segmented">
            <button
              className={mode === "file" ? "active" : ""}
              onClick={() => switchMode("file")}
            >
              Subtitle
            </button>
            <button
              className={mode === "video" ? "active" : ""}
              onClick={() => switchMode("video")}
            >
              Video
            </button>
            <button
              className={mode === "url" ? "active" : ""}
              onClick={() => switchMode("url")}
            >
              YouTube · URL
            </button>
            <button
              className={mode === "live" ? "active" : ""}
              onClick={() => switchMode("live")}
            >
              🎤 Live
            </button>
          </div>

          {mode === "live" ? (
            <div className="url-block">
              <div className="field-label">Spoken language</div>
              <select
                value={videoLang}
                onChange={(e) => setVideoLang(e.target.value)}
                disabled={live}
              >
                <option value="english">English</option>
                <option value="kinyarwanda">Kinyarwanda (Digital Umuganda)</option>
                <option value="french">French</option>
                <option value="swahili">Swahili</option>
              </select>
              <button
                className={`btn${live ? " live-active" : ""}`}
                onClick={live ? stopLive : startLive}
              >
                {live ? (
                  <>
                    <span className="rec-dot" /> Stop recording
                  </>
                ) : (
                  "Start recording"
                )}
              </button>
              <p className="hint">
                Captions fill in every few seconds while you talk. Stop when
                you're done, then translate as usual.
              </p>
            </div>
          ) : mode === "url" ? (
            <div className="url-block">
              <div className="field-label">Paste a video link</div>
              <input
                className="url-input"
                type="url"
                placeholder="https://youtube.com/watch?v=…"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && onFetchUrl()}
              />
              <select value={videoLang} onChange={(e) => setVideoLang(e.target.value)}>
                <option value="english">Content language: English</option>
                <option value="kinyarwanda">Content language: Kinyarwanda</option>
                <option value="french">Content language: French</option>
                <option value="swahili">Content language: Swahili</option>
              </select>
              <button
                className="btn"
                onClick={onFetchUrl}
                disabled={fetching || !url.trim()}
              >
                {fetching ? "Fetching captions…" : "Fetch captions"}
              </button>
              <p className="hint">
                Uses the video's own captions if present, otherwise transcribes
                the audio.
              </p>
              {urlNote && <p className="hint ok-hint">{urlNote}</p>}
            </div>
          ) : (
            <>
              <label
                className={`dropzone${dragging ? " drag" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  const f = e.dataTransfer.files?.[0];
                  if (f) handleDrop(f);
                }}
              >
                <span className="dz-icon">{mode === "video" ? "🎬" : "📄"}</span>
                <span className="dz-title">
                  {transcribing
                    ? "Transcribing…"
                    : mode === "video"
                      ? "Drop a video or audio file"
                      : "Drop a .srt or .vtt"}
                </span>
                <span className="dz-sub">or click to browse</span>
                <input
                  type="file"
                  accept={mode === "video" ? "video/*,audio/*" : ".srt,.vtt"}
                  onChange={(e) =>
                    e.target.files?.[0] && handleDrop(e.target.files[0])
                  }
                  hidden
                />
              </label>

              {mode === "file" ? (
                <button
                  className="linkish"
                  onClick={() => loadText("sample.srt", SAMPLE)}
                >
                  or load a sample file
                </button>
              ) : (
                <div>
                  <div className="field-label">Spoken language</div>
                  <select
                    value={videoLang}
                    onChange={(e) => setVideoLang(e.target.value)}
                  >
                    <option value="english">English</option>
                    <option value="kinyarwanda">Kinyarwanda (Digital Umuganda)</option>
                    <option value="french">French</option>
                    <option value="swahili">Swahili</option>
                  </select>
                </div>
              )}
            </>
          )}

          <div>
            <div className="field-label">Translate</div>
            <div className="lang-row">
              <select value={source} onChange={(e) => setSource(e.target.value)}>
                {languages.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name}
                  </option>
                ))}
              </select>
              <button className="swap" onClick={swap} title="Swap languages">
                ⇄
              </button>
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                {languages.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="engine-pick">
            <div className="field-label">Engine</div>
            <select value={engine} onChange={(e) => setEngine(e.target.value)}>
              {engines.map((eng) => (
                <option key={eng.id} value={eng.id} disabled={!eng.available}>
                  {eng.label}
                  {eng.available ? "" : " — offline"}
                </option>
              ))}
            </select>
            <span className={`status ${modelReady ? "ok" : "wait"}`}>
              <span className="dot" />
              {modelReady ? "models ready" : "warming models…"}
            </span>
          </div>

          <button className="btn primary" onClick={runTranslate} disabled={!canTranslate}>
            {busy
              ? "Translating…"
              : `Translate to ${langName(target)}`}
          </button>

          {busy && (
            <div className="progress">
              <div className="track">
                <div
                  className="fill"
                  style={{
                    width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`,
                  }}
                />
              </div>
              <span className="label">
                {progress.done} / {progress.total} cues
              </span>
            </div>
          )}

          {hasOutput && (
            <div className="export-row">
              <button className="btn" onClick={() => doDownload("srt")}>
                ⬇ .srt
              </button>
              <button className="btn" onClick={() => doDownload("vtt")}>
                ⬇ .vtt
              </button>
            </div>
          )}

          {hasOutput && hasVideoSource && (
            <button className="btn burn" onClick={burnHandler} disabled={burning}>
              {burning ? "Rendering video…" : "🎞 Captioned video (.mp4)"}
            </button>
          )}

          {error && <p className="error">{error}</p>}
          {activeEngine && <p className="origin">{activeEngine.origin}</p>}
        </section>

        {/* ---------------- results panel ---------------- */}
        <section className="panel results">
          <div className="results-head">
            <span className="file">{cues.length ? filename : "No file yet"}</span>
            <span className="count">
              {cues.length
                ? `${cues.length} cue${cues.length === 1 ? "" : "s"}`
                : asrReady && modelReady
                  ? "ready"
                  : "warming up"}
            </span>
          </div>

          {cues.length === 0 ? (
            <div className="empty">
              <div className="big">Open a subtitle file or a video.</div>
              <div>
                Captions in, Kinyarwanda out — timing untouched. Two engines:
                NLLB-200 and Digital Umuganda.
              </div>
            </div>
          ) : (
            <div className="cue-list">
              {cues.map((c, i) => {
                const t = translations[i];
                return (
                  <div className={`cue${t ? " done" : ""}`} key={`${c.index}-${i}`}>
                    <div className="cue-top">
                      <span className="cue-index">
                        {String(c.index).padStart(2, "0")}
                      </span>
                      <span className="cue-time">
                        {c.start} → {c.end}
                      </span>
                    </div>
                    <div className="cue-body">
                      <div className="cue-src">{c.text}</div>
                      <div className={`cue-tgt${t ? " filled" : busy ? " pending" : ""}`}>
                        {t ? t : busy ? <span className="shimmer" /> : "—"}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <footer className="foot">
        Built in Rwanda · models: <b>NLLB-200</b> &amp; <b>Digital Umuganda / Mbaza</b>
      </footer>
    </div>
  );
}
