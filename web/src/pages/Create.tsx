import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  FileText,
  Mic,
  Upload,
  PlaySquare,
} from "lucide-react";
import { type IntakeMode, useWorkflow } from "../workflow";

const SOURCES: { mode: IntakeMode; title: string; sub: string; icon: typeof FileText }[] = [
  { mode: "file", title: "Subtitle file", sub: ".srt or .vtt", icon: FileText },
  { mode: "video", title: "Video / audio", sub: "Upload & transcribe", icon: Upload },
  { mode: "url", title: "YouTube link", sub: "Fetch captions", icon: PlaySquare },
  { mode: "live", title: "Live mic", sub: "Speak & caption", icon: Mic },
];

export default function Create() {
  const wf = useWorkflow();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [dragging, setDragging] = useState(false);

  const pickSource = (mode: IntakeMode) => {
    wf.setIntakeMode(mode);
    setStep(2);
  };

  const handleDrop = (file: File) =>
    wf.intakeMode === "video" ? wf.onVideo(file) : wf.onFile(file);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            What will we <span className="accent">create</span> today?
          </h1>
          <p className="sub">Pick a source, set your languages, and go.</p>
        </div>
      </div>

      <div className="wizard-steps">
        <div className={`wizard-step${step === 1 ? " active" : step > 1 ? " done" : ""}`}>
          <span className="num">1</span> Source
        </div>
        <div className="wizard-sep" />
        <div className={`wizard-step${step === 2 ? " active" : step > 2 ? " done" : ""}`}>
          <span className="num">2</span> Languages
        </div>
        <div className="wizard-sep" />
        <div className={`wizard-step${step === 3 ? " active" : ""}`}>
          <span className="num">3</span> Process
        </div>
      </div>

      <div className="panel" style={{ maxWidth: 640 }}>
        {step === 1 && (
          <div className="source-grid">
            {SOURCES.map(({ mode, title, sub, icon: Icon }) => (
              <button
                key={mode}
                className={`source-card${wf.intakeMode === mode ? " active" : ""}`}
                onClick={() => pickSource(mode)}
              >
                <Icon />
                <span className="source-title">{title}</span>
                <span className="source-sub">{sub}</span>
              </button>
            ))}
          </div>
        )}

        {step === 2 && (
          <>
            <div style={{ marginBottom: 18 }}>
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

            {wf.intakeMode !== "file" && (
              <div style={{ marginBottom: 18 }}>
                <div className="field-label">Spoken language</div>
                <select value={wf.videoLang} onChange={(e) => wf.setVideoLang(e.target.value)}>
                  <option value="english">English</option>
                  <option value="kinyarwanda">Kinyarwanda (Digital Umuganda)</option>
                  <option value="french">French</option>
                  <option value="swahili">Swahili</option>
                </select>
              </div>
            )}

            <div className="engine-pick" style={{ marginBottom: 4 }}>
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
          </>
        )}

        {step === 3 && wf.intakeMode === "file" && (
          <div>
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
              <FileText className="dz-icon" />
              <span className="dz-title">Drop a .srt or .vtt</span>
              <span className="dz-sub">or click to browse</span>
              <input
                type="file"
                accept=".srt,.vtt"
                onChange={(e) => e.target.files?.[0] && handleDrop(e.target.files[0])}
                hidden
              />
            </label>
            <button className="linkish" onClick={wf.loadSample} style={{ marginTop: 10 }}>
              or load a sample file
            </button>
          </div>
        )}

        {step === 3 && wf.intakeMode === "video" && (
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
            <Upload className="dz-icon" />
            <span className="dz-title">
              {wf.transcribing ? "Transcribing…" : "Drop a video or audio file"}
            </span>
            <span className="dz-sub">or click to browse</span>
            <input
              type="file"
              accept="video/*,audio/*"
              onChange={(e) => e.target.files?.[0] && handleDrop(e.target.files[0])}
              hidden
            />
          </label>
        )}

        {step === 3 && wf.intakeMode === "url" && (
          <div className="url-block">
            <div className="field-label">Paste a video link</div>
            <input
              className="url-input"
              type="url"
              placeholder="https://youtube.com/watch?v=…"
              value={wf.url}
              onChange={(e) => wf.setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && wf.onFetchUrl()}
            />
            <button
              className="btn primary"
              onClick={wf.onFetchUrl}
              disabled={wf.fetching || !wf.url.trim()}
            >
              {wf.fetching ? "Fetching captions…" : "Fetch captions"}
            </button>
            <p className="hint">
              Uses the video's own captions if present, otherwise transcribes the audio.
            </p>
            {wf.urlNote && <p className="hint ok-hint">{wf.urlNote}</p>}
          </div>
        )}

        {step === 3 && wf.intakeMode === "live" && (
          <div className="url-block">
            <button
              className={`btn primary${wf.live ? " live-active" : ""}`}
              onClick={wf.live ? wf.stopLive : wf.startLive}
            >
              {wf.live ? (
                <>
                  <span className="rec-dot" /> Stop recording
                </>
              ) : (
                "Start recording"
              )}
            </button>
            <p className="hint">
              Captions fill in every few seconds while you talk. Stop when you're done.
            </p>
          </div>
        )}

        {wf.error && <p className="error" style={{ marginTop: 16 }}>{wf.error}</p>}

        <div className="wizard-actions">
          <button
            className="btn"
            onClick={() => setStep((s) => (s > 1 ? ((s - 1) as 1 | 2 | 3) : s))}
            disabled={step === 1}
          >
            <ArrowLeft size={15} /> Back
          </button>
          {step < 3 && (
            <button className="btn primary" onClick={() => setStep((s) => (s + 1) as 1 | 2 | 3)}>
              Continue <ArrowRight size={15} />
            </button>
          )}
        </div>
      </div>
    </>
  );
}
