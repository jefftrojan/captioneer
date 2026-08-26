import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { extractYouTubeId } from "./frame";

interface PreviewModalProps {
  onClose: () => void;
  startSeconds: number;
  caption: string;
  videoSrc?: string;
  youtubeUrl?: string;
}

export default function PreviewModal({
  onClose,
  startSeconds,
  caption,
  videoSrc,
  youtubeUrl,
}: PreviewModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const youtubeId = youtubeUrl ? extractYouTubeId(youtubeUrl) : null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-caption">{caption}</span>
          <button className="icon-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          {videoSrc ? (
            <video
              ref={videoRef}
              src={videoSrc}
              controls
              autoPlay
              onLoadedMetadata={(e) => {
                e.currentTarget.currentTime = startSeconds;
              }}
            />
          ) : youtubeId ? (
            <iframe
              src={`https://www.youtube.com/embed/${youtubeId}?start=${Math.floor(startSeconds)}&autoplay=1`}
              title="Preview"
              allow="autoplay; encrypted-media"
              allowFullScreen
            />
          ) : (
            <div className="empty">
              <div className="big">No preview available</div>
              <div>This session has no video attached.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
