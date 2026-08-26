import { useState } from "react";
import { CheckCircle2, Clapperboard, Languages, PlaySquare } from "lucide-react";
import { useWorkflow } from "../workflow";
import { loadHistory } from "../history";
import { SOURCE_LABEL, timeAgo } from "../format";

export default function Home() {
  const { engines, navigate, openHistoryEntry } = useWorkflow();
  const [history] = useState(() => loadHistory());

  const cuesTranslated = history.reduce((sum, e) => sum + e.translatedCount, 0);
  const rendered = history.filter((e) => e.rendered).length;
  const availableEngines = engines.filter((e) => e.available).length;
  const recent = history.slice(0, 6);
  const youtubeSources = history.filter((e) => e.source === "url").slice(0, 4);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            Good morning, <span className="accent">welcome back</span>
          </h1>
          <p className="sub">Here's what's happening with your captions.</p>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => navigate("create")}>
            <Clapperboard size={16} /> Create
          </button>
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat-card green">
          <div className="stat-top">
            <span className="stat-label">Videos processed</span>
            <span className="stat-icon">
              <Clapperboard size={15} />
            </span>
          </div>
          <div className="stat-value">{history.length}</div>
          <div className="stat-foot">
            <span className="stat-pill">All time</span>
            Sessions completed
          </div>
        </div>

        <div className="stat-card green">
          <div className="stat-top">
            <span className="stat-label">Cues translated</span>
            <span className="stat-icon">
              <Languages size={15} />
            </span>
          </div>
          <div className="stat-value">{cuesTranslated}</div>
          <div className="stat-foot">
            <span className="stat-pill">Total</span>
            Across all sessions
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-top">
            <span className="stat-label">Models ready</span>
            <span className="stat-icon">
              <CheckCircle2 size={15} />
            </span>
          </div>
          <div className="stat-value">
            {availableEngines}/{engines.length || 2}
          </div>
          <div className="stat-foot">
            <span className="stat-pill">Engines</span>
            NLLB-200 &amp; Digital Umuganda
          </div>
        </div>

        <div className="stat-card coral">
          <div className="stat-top">
            <span className="stat-label">Rendered videos</span>
            <span className="stat-icon">
              <Clapperboard size={15} />
            </span>
          </div>
          <div className="stat-value">{rendered}</div>
          <div className="stat-foot">
            <span className="stat-pill">Open</span>
            Captions burned in
          </div>
        </div>
      </div>

      <div className="dash-grid">
        <div className="panel">
          <div className="card-title">Recent activity</div>
          {recent.length === 0 ? (
            <div className="empty">
              <div className="big">No sessions yet</div>
              <div>Create your first captions to see activity here.</div>
            </div>
          ) : (
            <div>
              {recent.map((e) => (
                <div
                  key={e.id}
                  className="list-row link"
                  onClick={() => openHistoryEntry(e)}
                >
                  <div className="avatar">{SOURCE_LABEL[e.source]?.[0] ?? "?"}</div>
                  <div className="row-main">
                    <div className="row-title">{e.title}</div>
                    <div className="row-sub">
                      {SOURCE_LABEL[e.source]} · {e.cueCount} cues · {timeAgo(e.timestamp)}
                    </div>
                  </div>
                  {e.rendered && <span className="badge-rendered">Rendered</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="panel">
          <div className="card-head">
            <span className="eyebrow">Channels</span>
            <button className="link" onClick={() => navigate("channels")}>
              View all
            </button>
          </div>
          <div className="card-title">YouTube sources</div>
          {youtubeSources.length === 0 ? (
            <div className="list-row" style={{ marginBottom: 10 }}>
              <div className="avatar">
                <PlaySquare size={16} />
              </div>
              <div className="row-main">
                <div className="row-title">No sources yet</div>
                <div className="row-sub">Paste a YouTube link to get started</div>
              </div>
            </div>
          ) : (
            youtubeSources.map((e) => (
              <div key={e.id} className="list-row link" onClick={() => openHistoryEntry(e)}>
                <div className="avatar">
                  <PlaySquare size={16} />
                </div>
                <div className="row-main">
                  <div className="row-title">{e.title}</div>
                  <div className="row-sub">{e.cueCount} cues</div>
                </div>
                <span className="row-meta">{timeAgo(e.timestamp)}</span>
              </div>
            ))
          )}
          <button className="list-row add" onClick={() => navigate("channels")}>
            + Add channel
          </button>
        </div>
      </div>
    </>
  );
}
