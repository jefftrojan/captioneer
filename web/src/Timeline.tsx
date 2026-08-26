import { useEffect, useMemo, useRef, useState } from "react";
import { type Cue, parseTimeToSeconds } from "./subtitles";
import { captureFrame } from "./frame";

interface TimelineProps {
  cues: Cue[];
  translations: string[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  activeIndex: number | null;
  /** Object URL for an uploaded video/audio file this session — enables
   * real frame thumbnails. Omitted for file/URL/live sessions (no video
   * bytes available client-side), which fall back to plain color bars. */
  videoSrc?: string;
  rangeStart?: number | null;
  rangeEnd?: number | null;
}

const MIN_PX_PER_SEC = 4;
const MAX_PX_PER_SEC = 120;
const DEFAULT_PX_PER_SEC = 30;
const MIN_SEG_WIDTH = 3;
// Extra viewport-widths of segments to keep mounted outside the visible area,
// so a small scroll doesn't cause a visible pop-in.
const BUFFER_RATIO = 0.5;
// Thumbnails are captured per time bucket, not per cue — many cues are
// sub-second, so a periodic filmstrip (like real editors use) instead of
// one capture per caption avoids redundant work and visual noise.
const THUMB_BUCKET_SEC = 2;

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/**
 * A horizontal, zoomable timeline of cues — replaces rendering every cue as
 * a stacked card. Position is a direct function of time, so virtualization
 * is just "which cues overlap the visible time window" — no list-virtualization
 * library needed, and it stays smooth whether there are 50 cues or 5,000.
 */
export default function Timeline({
  cues,
  translations,
  selectedIndex,
  onSelect,
  activeIndex,
  videoSrc,
  rangeStart,
  rangeEnd,
}: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [pxPerSecond, setPxPerSecond] = useState(DEFAULT_PX_PER_SEC);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setViewportWidth(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const times = useMemo(
    () => cues.map((c) => ({ start: parseTimeToSeconds(c.start), end: parseTimeToSeconds(c.end) })),
    [cues],
  );
  const totalDuration = useMemo(() => times.reduce((max, t) => Math.max(max, t.end), 0), [times]);
  const totalWidth = Math.max(totalDuration * pxPerSecond, viewportWidth);

  const visible = useMemo(() => {
    const buffer = viewportWidth * BUFFER_RATIO;
    const visStart = (scrollLeft - buffer) / pxPerSecond;
    const visEnd = (scrollLeft + viewportWidth + buffer) / pxPerSecond;
    const out: number[] = [];
    for (let i = 0; i < times.length; i++) {
      if (times[i].end >= visStart && times[i].start <= visEnd) out.push(i);
    }
    return out;
  }, [times, scrollLeft, viewportWidth, pxPerSecond]);

  // Auto-scroll to keep the actively-translating segment in view.
  useEffect(() => {
    if (activeIndex == null || !containerRef.current || !times[activeIndex]) return;
    const el = containerRef.current;
    const segLeft = times[activeIndex].start * pxPerSecond;
    const segRight = times[activeIndex].end * pxPerSecond;
    if (segLeft < el.scrollLeft || segRight > el.scrollLeft + el.clientWidth) {
      el.scrollLeft = Math.max(0, segLeft - el.clientWidth / 3);
    }
  }, [activeIndex, pxPerSecond, times]);

  // --- Thumbnails: a hidden <video> element, seeked and captured on demand
  // for whichever time buckets are currently visible. Serialized internally
  // by captureFrame (one <video> can only represent one currentTime).
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const thumbCache = useRef<Map<number, string>>(new Map());
  const pendingBuckets = useRef<Set<number>>(new Set());
  const [, bumpThumbVersion] = useState(0);

  useEffect(() => {
    thumbCache.current = new Map();
    pendingBuckets.current = new Set();
    setVideoReady(false);
    if (!videoSrc) {
      videoElRef.current = null;
      return;
    }
    const v = document.createElement("video");
    v.src = videoSrc;
    v.muted = true;
    v.preload = "auto";
    v.addEventListener("loadedmetadata", () => setVideoReady(true), { once: true });
    videoElRef.current = v;
    return () => {
      v.src = "";
      videoElRef.current = null;
    };
  }, [videoSrc]);

  useEffect(() => {
    if (!videoSrc || !videoReady || !videoElRef.current) return;
    const video = videoElRef.current;
    const buckets = new Set<number>();
    for (const i of visible) {
      buckets.add(Math.floor(times[i].start / THUMB_BUCKET_SEC) * THUMB_BUCKET_SEC);
    }
    for (const bucket of buckets) {
      if (thumbCache.current.has(bucket) || pendingBuckets.current.has(bucket)) continue;
      pendingBuckets.current.add(bucket);
      captureFrame(video, bucket)
        .then((url) => {
          thumbCache.current.set(bucket, url);
          bumpThumbVersion((n) => n + 1);
        })
        .catch(() => {
          // A frame that fails to capture just stays a plain color bar.
        })
        .finally(() => pendingBuckets.current.delete(bucket));
    }
  }, [visible, videoSrc, videoReady, times]);

  const rulerStep = useMemo(() => {
    const targetPx = 90;
    const rawSec = targetPx / pxPerSecond;
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    return steps.find((s) => s >= rawSec) ?? 600;
  }, [pxPerSecond]);
  const rulerMarks = useMemo(() => {
    const marks: number[] = [];
    for (let t = 0; t <= totalDuration; t += rulerStep) marks.push(t);
    return marks;
  }, [totalDuration, rulerStep]);

  return (
    <div className="timeline">
      <div className="timeline-toolbar">
        <span className="timeline-duration">
          {cues.length} cues · {fmtTime(totalDuration)} total
        </span>
        <div className="zoom-control">
          <span>Zoom</span>
          <input
            type="range"
            min={MIN_PX_PER_SEC}
            max={MAX_PX_PER_SEC}
            value={pxPerSecond}
            onChange={(e) => setPxPerSecond(Number(e.target.value))}
          />
        </div>
      </div>
      <div
        className="timeline-scroll"
        ref={containerRef}
        onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
      >
        <div className="timeline-ruler" style={{ width: totalWidth }}>
          {rulerMarks.map((t) => (
            <span key={t} className="timeline-tick" style={{ left: t * pxPerSecond }}>
              {fmtTime(t)}
            </span>
          ))}
        </div>
        <div className="timeline-track" style={{ width: totalWidth }}>
          {rangeStart != null && rangeEnd != null && (
            <div
              className="timeline-range"
              style={{
                left: rangeStart * pxPerSecond,
                width: Math.max(0, (rangeEnd - rangeStart) * pxPerSecond),
              }}
            />
          )}
          {visible.map((i) => {
            const { start, end } = times[i];
            const width = Math.max(MIN_SEG_WIDTH, (end - start) * pxPerSecond);
            const state = i === activeIndex ? "active" : translations[i] ? "done" : "pending";
            const bucket = Math.floor(start / THUMB_BUCKET_SEC) * THUMB_BUCKET_SEC;
            const thumb = videoSrc ? thumbCache.current.get(bucket) : undefined;
            return (
              <button
                key={i}
                className={`timeline-seg ${state}${selectedIndex === i ? " selected" : ""}${thumb ? " has-thumb" : ""}`}
                style={{
                  left: start * pxPerSecond,
                  width,
                  backgroundImage: thumb ? `url(${thumb})` : undefined,
                }}
                onClick={() => onSelect(i)}
                title={cues[i].text}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
