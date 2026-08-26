import { useEffect, useRef } from "react";
import { type Cue } from "./subtitles";

interface TranscriptPanelProps {
  cues: Cue[];
  translations: string[];
  selectedIndex: number | null;
  /** Cue under the playhead right now (-1 when none), from PreviewPane —
   * drives the "live" highlight and auto-scroll, independent of click
   * selection so scrubbing/playing doesn't fight manual review. */
  liveIndex: number;
  onSelect: (index: number) => void;
}

/**
 * A full scrolling list of every cue (source + translation), living beside
 * the video — the "watch the whole transcript, not just one cue at a time"
 * view a real captioning tool needs, on top of the single-cue editor below
 * and the zoomed-out Timeline filmstrip.
 */
export default function TranscriptPanel({
  cues,
  translations,
  selectedIndex,
  liveIndex,
  onSelect,
}: TranscriptPanelProps) {
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (liveIndex < 0) return;
    rowRefs.current[liveIndex]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [liveIndex]);

  return (
    <div className="transcript-panel">
      {cues.map((cue, i) => (
        <button
          key={i}
          ref={(el) => (rowRefs.current[i] = el)}
          className={`transcript-row${i === liveIndex ? " live" : ""}${i === selectedIndex ? " selected" : ""}`}
          onClick={() => onSelect(i)}
        >
          <span className="transcript-time">{cue.start.split(",")[0]}</span>
          <span className="transcript-text">
            <span className="transcript-src">{cue.text}</span>
            {translations[i] && <span className="transcript-tgt">{translations[i]}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}
