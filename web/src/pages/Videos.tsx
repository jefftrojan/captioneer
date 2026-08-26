import { useState } from "react";
import { Clapperboard, Download } from "lucide-react";
import { useWorkflow } from "../workflow";
import { loadHistory } from "../history";
import { SOURCE_LABEL, timeAgo } from "../format";
import { download, serialize } from "../subtitles";

export default function Videos() {
  const { navigate, openHistoryEntry } = useWorkflow();
  const [history] = useState(() => loadHistory());

  const exportEntry = (e: ReturnType<typeof loadHistory>[number], fmt: "srt" | "vtt", ev: React.MouseEvent) => {
    ev.stopPropagation();
    const cuesToExport = e.cues.map((c, i) => ({ ...c, text: e.translations[i] || c.text }));
    download(`${e.title.replace(/\.(srt|vtt)$/i, "")}.${fmt}`, serialize(cuesToExport, fmt));
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            Your <span className="accent">history</span>
          </h1>
          <p className="sub">Every session on this browser, with export and render status.</p>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => navigate("create")}>
            + New session
          </button>
        </div>
      </div>

      <div className="panel">
        {history.length === 0 ? (
          <div className="empty">
            <div className="big">No sessions yet</div>
            <div>Sessions you create will show up here.</div>
          </div>
        ) : (
          <div>
            {history.map((e) => (
              <div key={e.id} className="list-row link" onClick={() => openHistoryEntry(e)}>
                <div className="avatar">
                  <Clapperboard size={16} />
                </div>
                <div className="row-main">
                  <div className="row-title">{e.title}</div>
                  <div className="row-sub">
                    {SOURCE_LABEL[e.source]} · {e.sourceLang.split("_")[0]}→
                    {e.targetLang.split("_")[0]} · {e.cueCount} cues
                    {e.translatedCount > 0 && ` · ${e.translatedCount} translated`}
                  </div>
                </div>
                {e.translatedCount > 0 && (
                  <div className="row-quick-export" onClick={(ev) => ev.stopPropagation()}>
                    <button className="icon-btn" title="Download .srt" onClick={(ev) => exportEntry(e, "srt", ev)}>
                      <Download size={14} />
                    </button>
                  </div>
                )}
                {e.rendered ? (
                  <span className="badge-rendered">Rendered</span>
                ) : (
                  <span className="badge-pending">Not rendered</span>
                )}
                <span className="row-meta">{timeAgo(e.timestamp)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
