// Client-side video frame capture for timeline thumbnails — a pure browser
// API, no new dependency.

let captureQueue: Promise<void> = Promise.resolve();

/**
 * Seek `video` to `time` and capture the frame as a small JPEG data URL.
 * A single <video> element can only represent one currentTime at once, so
 * concurrent callers are serialized through a queue rather than racing.
 */
export function captureFrame(
  video: HTMLVideoElement,
  time: number,
  width = 120,
  height = 68,
): Promise<string> {
  const run = () =>
    new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("error", onError);
      };
      const onSeeked = () => {
        cleanup();
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("no 2d context"));
        ctx.drawImage(video, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.6));
      };
      const onError = () => {
        cleanup();
        reject(new Error("video error"));
      };
      video.addEventListener("seeked", onSeeked);
      video.addEventListener("error", onError);
      video.currentTime = Math.max(0, time);
    });

  const result = captureQueue.then(run, run);
  captureQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
