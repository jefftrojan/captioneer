import { useState } from "react";
import { PlaySquare } from "lucide-react";
import { useWorkflow } from "../workflow";
import { loadHistory } from "../history";
import { timeAgo } from "../format";

export default function Channels() {
  const wf = useWorkflow();
  const [history] = useState(() => loadHistory().filter((e) => e.source === "url"));

  const fetchIt = () => {
    wf.setIntakeMode("url");
    wf.onFetchUrl();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            <span className="accent">YouTube</span> sources
          </h1>
          <p className="sub">Pull captions straight from a video link.</p>
        </div>
      </div>

      <div className="panel" style={{ maxWidth: 640, marginBottom: 22 }}>
        <div className="url-block">
          <div className="field-label">Paste a video link</div>
          <input
            className="url-input"
            type="url"
            placeholder="https://youtube.com/watch?v=…"
            value={wf.url}
            onChange={(e) => wf.setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && fetchIt()}
          />
          <select value={wf.videoLang} onChange={(e) => wf.setVideoLang(e.target.value)}>
            <option value="english">Content language: English</option>
            <option value="kinyarwanda">Content language: Kinyarwanda</option>
            <option value="french">Content language: French</option>
            <option value="swahili">Content language: Swahili</option>
          </select>
          <button className="btn primary" onClick={fetchIt} disabled={wf.fetching || !wf.url.trim()}>
            {wf.fetching ? "Fetching captions…" : "Fetch captions"}
          </button>
          <p className="hint">
            Uses the video's own captions if present, otherwise transcribes the audio.
          </p>
          {wf.urlNote && <p className="hint ok-hint">{wf.urlNote}</p>}
          {wf.error && <p className="error">{wf.error}</p>}
        </div>
      </div>

      <div className="panel">
        <div className="card-title">Recent sources</div>
        {history.length === 0 ? (
          <div className="empty">
            <div className="big">No YouTube sources yet</div>
            <div>Fetched videos will show up here.</div>
          </div>
        ) : (
          <div>
            {history.map((e) => (
              <div key={e.id} className="list-row link" onClick={() => wf.openHistoryEntry(e)}>
                <div className="avatar">
                  <PlaySquare size={16} />
                </div>
                <div className="row-main">
                  <div className="row-title">{e.title}</div>
                  <div className="row-sub">{e.cueCount} cues</div>
                </div>
                <span className="row-meta">{timeAgo(e.timestamp)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
