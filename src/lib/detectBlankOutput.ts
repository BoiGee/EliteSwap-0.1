/**
 * Detects whether a stream's video track is stuck rendering a near-black
 * frame. Not a "is this stream alive" check (a live-but-black track passes
 * that trivially) -- this samples actual pixel content, because Decart's
 * setImage() can silently fail or stall mid-renegotiation with no SDK-level
 * error, leaving the output track technically live but producing nothing.
 */
export async function isOutputStuckBlank(
  stream: MediaStream,
  opts?: {
    warmupMs?: number;
    sampleCount?: number;
    sampleIntervalMs?: number;
    brightnessThreshold?: number;
  },
): Promise<boolean> {
  const track = stream.getVideoTracks()[0];
  if (!track || track.readyState !== "live") return false; // no track to judge; don't false-flag

  const warmupMs = opts?.warmupMs ?? 1200;
  const sampleCount = opts?.sampleCount ?? 3;
  const sampleIntervalMs = opts?.sampleIntervalMs ?? 1000;
  const brightnessThreshold = opts?.brightnessThreshold ?? 8; // 0-255 average luma

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";
  document.body.appendChild(video);
  video.srcObject = stream;

  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 36;
  const ctx = canvas.getContext("2d", { willReadFrequently: true } as CanvasRenderingContext2DSettings);

  const cleanup = () => {
    try { video.pause(); } catch { /* noop */ }
    video.srcObject = null;
    try { video.remove(); } catch { /* noop */ }
  };

  try {
    await video.play().catch(() => {});
    await new Promise((r) => setTimeout(r, warmupMs));
    if (!ctx) return false; // can't sample; don't false-flag

    for (let i = 0; i < sampleCount; i++) {
      if (video.readyState < 2 || video.videoWidth === 0) return false; // never decoded a frame at all; a different failure mode
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let sum = 0;
      for (let p = 0; p < data.length; p += 4) {
        sum += 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      }
      const avg = sum / (data.length / 4);
      if (avg > brightnessThreshold) return false; // at least one sample has real content
      if (i < sampleCount - 1) await new Promise((r) => setTimeout(r, sampleIntervalMs));
    }
    return true; // every sample came back near-black
  } finally {
    cleanup();
  }
}
