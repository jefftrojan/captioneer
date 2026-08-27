import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
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

function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/**
 * Always-visible player above the timeline, instead of the old
 * double-click-only modal. A minimal custom control bar (play/pause, time,
 * click-to-seek) replaces the native browser controls to match the editor's
 * own look rather than each browser's default chrome. Overlays the cue
 * whose range contains the current playback time — translated text if
 * there is one, otherwise the source — so it doubles as a rough WYSIWYG
 * preview of the burned-in result.
 */
export default function PreviewPane({
  videoSrc,
  cues,
  translations,
  seekTo,
  onActiveChange,
}: PreviewPaneProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);

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

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play();
    else v.pause();
  };

  const seekToFraction = (clientX: number) => {
    const bar = barRef.current;
    const v = videoRef.current;
    if (!bar || !v || !duration) return;
    const rect = bar.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    v.currentTime = fraction * duration;
  };

  const progress = duration ? (currentTime / duration) * 100 : 0;

  return (
    <div className="preview-pane">
      {videoSrc ? (
        <>
          <video
            ref={videoRef}
            src={videoSrc}
            onClick={togglePlay}
            onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
            onDurationChange={(e) => setDuration(e.currentTarget.duration)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
          />
          {overlayText && <div className="preview-caption">{overlayText}</div>}
          <div
            ref={barRef}
            className="preview-controls"
            onClick={(e) => seekToFraction(e.clientX)}
          >
            <div className="preview-progress" style={{ width: `${progress}%` }} />
            <button
              className="preview-play"
              onClick={(e) => {
                e.stopPropagation();
                togglePlay();
              }}
            >
              {playing ? <Pause size={12} fill="currentColor" /> : <Play size={12} fill="currentColor" />}
            </button>
            <span className="preview-time">
              {fmtTime(currentTime)} / {fmtTime(duration)}
            </span>
          </div>
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
