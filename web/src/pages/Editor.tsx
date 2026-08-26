import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Clapperboard, Download, X } from "lucide-react";
import { useWorkflow } from "../workflow";
import Timeline from "../Timeline";
import PreviewPane from "../PreviewPane";
import TranscriptPanel from "../TranscriptPanel";
import { videoProxyUrl } from "../api";
import { parseTimeToSeconds } from "../subtitles";

function fmtEta(seconds: number): string {
  if (seconds < 60) return `~${Math.max(1, seconds)}s left`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `~${m}m ${s}s left`;
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export default function Editor() {
  const wf = useWorkflow();
  const [selectedIndex, setSelectedIndex] = useState<number | null>(wf.cues.length ? 0 : null);
  const [editingFocused, setEditingFocused] = useState(false);
  const [liveIndex, setLiveIndex] = useState(-1);

  // Uploaded video/audio bytes only exist client-side for the current
  // session (never persisted) — when present, they enable real timeline
  // thumbnails and an in-place preview instead of just plain color bars.
  const [videoSrc, setVideoSrc] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!wf.videoFile) {
      setVideoSrc(undefined);
      return;
    }
    const objUrl = URL.createObjectURL(wf.videoFile);
    setVideoSrc(objUrl);
    return () => URL.revokeObjectURL(objUrl);
  }, [wf.videoFile]);

  // Unified "anything a <video> element can play": an uploaded file's blob
  // URL, or the server's proxy for a URL session (it downloads the source
  // once via yt-dlp and serves the real file) — so preview, live transcript
  // sync, and timeline thumbnails all work the same regardless of source,
  // instead of falling back to an opaque platform embed for URL sessions.
  const previewSrc =
    videoSrc ?? (wf.intakeMode === "url" && wf.url.trim() ? videoProxyUrl(wf.url.trim()) : undefined);

  // While translating, the detail panel + timeline follow the cue currently
  // being processed — that's the "watch it happen" effect, not a separate
  // giant progress bar. Manual selection takes back over once busy ends, and
  // auto-follow pauses while you're actively typing so it can't yank the
  // text field out from under you mid-edit.
  useEffect(() => {
    if (wf.busy && wf.translatingIndex != null && !editingFocused) {
      setSelectedIndex(wf.translatingIndex);
    }
  }, [wf.busy, wf.translatingIndex, editingFocused]);

  const selected = selectedIndex != null ? wf.cues[selectedIndex] : null;
  const selectedTranslation = selectedIndex != null ? wf.translations[selectedIndex] : undefined;
  const isTranslatingSelected = wf.busy && selectedIndex === wf.translatingIndex;

  const step = (delta: number) => {
    if (selectedIndex == null) return;
    const next = Math.min(wf.cues.length - 1, Math.max(0, selectedIndex + delta));
    setSelectedIndex(next);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            <span className="accent">Editor</span>
          </h1>
          <p className="sub">Translate, review, and export your captions.</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => wf.navigate("create")}>
            + New session
          </button>
        </div>
      </div>

      <div className="editor-grid">
        <section className="panel editor-side">
          <div>
            <div className="field-label">Translate</div>
            <div className="lang-row">
              <select value={wf.source} onChange={(e) => wf.setSource(e.target.value)}>
                {wf.languages.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name}
                  </option>
                ))}
              </select>
              <button className="swap" onClick={wf.swap} title="Swap languages">
                ⇄
              </button>
              <select value={wf.target} onChange={(e) => wf.setTarget(e.target.value)}>
                {wf.languages.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="engine-pick">
            <div className="field-label">Engine</div>
            <select value={wf.engine} onChange={(e) => wf.setEngine(e.target.value)}>
              {wf.engines.map((eng) => (
                <option key={eng.id} value={eng.id} disabled={!eng.available}>
                  {eng.label}
                  {eng.available ? "" : " — offline"}
                </option>
              ))}
            </select>
            <span className={`status ${wf.modelReady ? "ok" : "wait"}`}>
              <span className="dot" />
              {wf.modelReady ? "models ready" : "warming models…"}
            </span>
          </div>

          {wf.estimatedSlow && !wf.busy && (
            <div className="warn-banner">
              <p>
                Digital Umuganda translates ~1 cue at a time on CPU — with{" "}
                {wf.cues.length} cues this could take a long time.
              </p>
              <button className="btn" onClick={() => wf.setEngine("nllb")}>
                Use NLLB-200 instead
              </button>
            </div>
          )}

          {wf.busy ? (
            <button className="btn" onClick={wf.cancelTranslate}>
              <X size={15} /> Cancel translating
            </button>
          ) : (
            <button className="btn primary" onClick={wf.runTranslate} disabled={!wf.canTranslate}>
              Translate to {wf.langName(wf.target)}
            </button>
          )}

          {wf.busy && (
            <div className="progress">
              <div className="track">
                <div
                  className="fill"
                  style={{
                    width: `${wf.progress.total ? (wf.progress.done / wf.progress.total) * 100 : 0}%`,
                  }}
                />
              </div>
              <span className="label">
                {wf.progress.done} / {wf.progress.total} cues
                {wf.etaSeconds != null && ` · ${fmtEta(wf.etaSeconds)}`}
              </span>
            </div>
          )}

          {wf.hasOutput && (
            <div className="range-control">
              <div className="field-label">Range</div>
              {wf.rangeStart != null && wf.rangeEnd != null ? (
                <div className="range-readout">
                  <span>
                    {fmtTime(wf.rangeStart)} – {fmtTime(wf.rangeEnd)}
                  </span>
                  <button className="linkish" onClick={wf.clearRange}>
                    Clear
                  </button>
                </div>
              ) : (
                <p className="hint">
                  Select a cue below, then mark it as the start or end of a clip
                  to export/render just that range.
                </p>
              )}
              <div className="range-actions">
                <button
                  className="btn"
                  disabled={!selected}
                  onClick={() => selected && wf.setRangeStart(parseTimeToSeconds(selected.start))}
                >
                  Set as start
                </button>
                <button
                  className="btn"
                  disabled={!selected}
                  onClick={() => selected && wf.setRangeEnd(parseTimeToSeconds(selected.end))}
                >
                  Set as end
                </button>
              </div>
            </div>
          )}

          {wf.hasOutput && (
            <div className="export-row">
              <button className="btn" onClick={() => wf.doDownload("srt")}>
                <Download size={14} /> .srt
              </button>
              <button className="btn" onClick={() => wf.doDownload("vtt")}>
                <Download size={14} /> .vtt
              </button>
            </div>
          )}

          {wf.hasOutput && wf.hasVideoSource && (
            <div className="dub-control">
              <label className="dub-toggle">
                <input
                  type="checkbox"
                  checked={wf.dubEnabled}
                  onChange={(e) => wf.setDubEnabled(e.target.checked)}
                />
                Dub audio into {wf.langName(wf.target)}
              </label>
              <button className="btn burn" onClick={wf.burnHandler} disabled={wf.burning}>
                <Clapperboard size={16} />
                {wf.burning
                  ? wf.dubEnabled
                    ? "Rendering & dubbing…"
                    : "Rendering video…"
                  : [
                      wf.dubEnabled ? "Dubbed" : "Captioned",
                      wf.rangeStart != null && wf.rangeEnd != null ? "clip" : "video",
                      "(.mp4)",
                    ].join(" ")}
              </button>
              {wf.dubEnabled && (
                <p className="hint">
                  Synthesized speech (Meta MMS-TTS) replaces the original
                  audio — voice quality and timing are approximate, not
                  broadcast-grade.
                </p>
              )}
            </div>
          )}

          {wf.error && <p className="error">{wf.error}</p>}
          {wf.activeEngine && <p className="origin">{wf.activeEngine.origin}</p>}
        </section>

        <section className="panel editor-main">
          <div className="editor-main-head">
            <span className="file">{wf.cues.length ? wf.filename : "No session yet"}</span>
            <span className="count">
              {wf.cues.length
                ? `${wf.cues.length} cue${wf.cues.length === 1 ? "" : "s"}`
                : wf.asrReady && wf.modelReady
                  ? "ready"
                  : "warming up"}
            </span>
          </div>

          {wf.cues.length === 0 ? (
            <div className="empty">
              <div className="big">Nothing to edit yet.</div>
              <div>
                Head to Create to open a subtitle file, video, YouTube link, or
                live mic session.
              </div>
            </div>
          ) : (
            <>
              <div className="preview-row">
                <PreviewPane
                  videoSrc={previewSrc}
                  cues={wf.cues}
                  translations={wf.translations}
                  seekTo={selected ? parseTimeToSeconds(selected.start) : null}
                  onActiveChange={setLiveIndex}
                />
                <TranscriptPanel
                  cues={wf.cues}
                  translations={wf.translations}
                  selectedIndex={selectedIndex}
                  liveIndex={liveIndex}
                  onSelect={setSelectedIndex}
                />
              </div>

              <Timeline
                cues={wf.cues}
                translations={wf.translations}
                selectedIndex={selectedIndex}
                onSelect={setSelectedIndex}
                activeIndex={wf.busy ? wf.translatingIndex : null}
                videoSrc={previewSrc}
                rangeStart={wf.rangeStart}
                rangeEnd={wf.rangeEnd}
              />

              {selected && (
                <div className="detail-panel">
                  <div className="detail-head">
                    <button className="icon-btn" onClick={() => step(-1)} disabled={selectedIndex === 0}>
                      <ChevronLeft size={16} />
                    </button>
                    <span className="cue-index">{String(selected.index).padStart(2, "0")}</span>
                    <span className="cue-time">
                      {selected.start} → {selected.end}
                    </span>
                    <button
                      className="icon-btn"
                      onClick={() => step(1)}
                      disabled={selectedIndex === wf.cues.length - 1}
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                  <div className="cue-body">
                    <div>
                      <div className="field-label">Source</div>
                      <textarea
                        className="cue-src"
                        value={selected.text}
                        rows={2}
                        onFocus={() => setEditingFocused(true)}
                        onBlur={() => setEditingFocused(false)}
                        onChange={(e) => wf.editCueText(selectedIndex!, e.target.value)}
                      />
                    </div>
                    <div>
                      <div className="field-label">Translation</div>
                      <textarea
                        className={`cue-tgt${selectedTranslation ? " filled" : ""}`}
                        value={selectedTranslation ?? ""}
                        rows={2}
                        readOnly={isTranslatingSelected}
                        placeholder={isTranslatingSelected ? "Translating…" : "No translation yet"}
                        onFocus={() => setEditingFocused(true)}
                        onBlur={() => setEditingFocused(false)}
                        onChange={(e) => wf.editTranslation(selectedIndex!, e.target.value)}
                      />
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </>
  );
}
