import { useEffect, useMemo, useRef, useState } from "react";
import { type Cue, parseTimeToSeconds } from "./subtitles";

interface PreviewPaneProps {
  /** Any playable src — an uploaded file's object URL, or the server's
   * /api/video-proxy URL for a URL-sourced session. Callers no longer need
   * to special-case a platform embed; a real <video> works for both. */
  videoSrc?: string;
  cues: Cue[];
  translations: string[];
  /** Seek the player here whenever it changes (e.g. selecting a cue) — an
   * imperative nudge, not a controlled value, so scrubbing stays native. */
  seekTo?: number | null;
  /** Fires whenever the cue under the playhead changes (-1 when none), so a
   * sibling transcript list can highlight/auto-scroll in lockstep. */
  onActiveChange?: (index: number) => void;
}

/**
 * Always-visible player (native controls) above the timeline, instead of the
 * old double-click-only modal. Overlays the cue whose range contains the
 * current playback time — translated text if there is one, otherwise the
 * source — so it doubles as a rough WYSIWYG preview of the burned-in result.
 */
export default function PreviewPane({
  videoSrc,
  cues,
  translations,
  seekTo,
  onActiveChange,
}: PreviewPaneProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(0);

  const times = useMemo(
    () => cues.map((c) => ({ start: parseTimeToSeconds(c.start), end: parseTimeToSeconds(c.end) })),
    [cues],
  );

  useEffect(() => {
    if (seekTo == null || !videoRef.current) return;
    videoRef.current.currentTime = seekTo;
  }, [seekTo]);

  const activeIndex = useMemo(() => {
    for (let i = 0; i < times.length; i++) {
      if (currentTime >= times[i].start && currentTime < times[i].end) return i;
    }
    return -1;
  }, [times, currentTime]);

  const overlayText =
    activeIndex >= 0 ? translations[activeIndex] || cues[activeIndex].text : null;

  useEffect(() => {
    onActiveChange?.(activeIndex);
  }, [activeIndex, onActiveChange]);

  return (
    <div className="preview-pane">
      {videoSrc ? (
        <>
          <video
            ref={videoRef}
            src={videoSrc}
            controls
            onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          />
          {overlayText && <div className="preview-caption">{overlayText}</div>}
        </>
      ) : (
        <div className="empty">
          <div className="big">No preview available</div>
          <div>This session has no video attached.</div>
        </div>
      )}
    </div>
  );
}
