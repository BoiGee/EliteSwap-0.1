import { useEffect, useState } from "react";

export interface DiagnosticsState {
  inputW?: number;
  inputH?: number;
  inputFps?: number;
  outputW?: number;
  outputH?: number;
  outputFps?: number;
  encoderLastBytes?: number;
  encoderLastMs?: number;
  encoderInFlight?: number;
  encoderQuality?: number;
  encoderOutW?: number;
  encoderPath?: "frame" | "bitmap" | "main";
  obsViewers?: number;
  connectionState?: string;
}

interface Props {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  state: DiagnosticsState;
}

/**
 * Diagnostics HUD — only mounted when ?debug=1 is in the URL.
 * Shows realtime input/output stream stats + OBS encoder telemetry.
 */
export function StudioDiagnostics({ localStream, remoteStream, state }: Props) {
  const [inputSettings, setInputSettings] = useState<MediaTrackSettings | null>(null);
  const [outputSettings, setOutputSettings] = useState<MediaTrackSettings | null>(null);
  const [outputFps, setOutputFps] = useState(0);

  useEffect(() => {
    const t = localStream?.getVideoTracks()[0];
    setInputSettings(t?.getSettings() ?? null);
  }, [localStream]);

  useEffect(() => {
    const t = remoteStream?.getVideoTracks()[0];
    setOutputSettings(t?.getSettings() ?? null);
    if (!remoteStream) {
      setOutputFps(0);
      return;
    }
    // Measure output FPS via a hidden <video> + requestVideoFrameCallback
    const video = document.createElement("video");
    video.srcObject = remoteStream;
    video.muted = true;
    video.playsInline = true;
    video.play().catch(() => {});

    let frames = 0;
    let last = performance.now();
    let cancelled = false;
    const v = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };

    const tick = () => {
      if (cancelled) return;
      frames++;
      const now = performance.now();
      if (now - last >= 1000) {
        setOutputFps(Math.round((frames * 1000) / (now - last)));
        frames = 0;
        last = now;
      }
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(tick);
    };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(tick);
    else {
      // Fallback: rAF approximation
      const raf = () => {
        if (cancelled) return;
        tick();
        requestAnimationFrame(raf);
      };
      requestAnimationFrame(raf);
    }

    return () => {
      cancelled = true;
      video.srcObject = null;
    };
  }, [remoteStream]);

  const row = (label: string, value: string | number | undefined) => (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground font-mono">{value ?? "—"}</span>
    </div>
  );

  return (
    <div className="fixed bottom-3 left-3 z-40 w-[260px] glass border border-border rounded-lg p-3 text-[10px] space-y-1.5 shadow-lg pointer-events-auto">
      <div className="font-heading uppercase tracking-wider text-primary text-[11px] mb-1">
        Diagnostics
      </div>
      {row("Connection", state.connectionState)}
      {row(
        "Input",
        inputSettings?.width
          ? `${inputSettings.width}×${inputSettings.height}@${inputSettings.frameRate?.toFixed(0) ?? "?"}`
          : undefined,
      )}
      {row(
        "Output",
        outputSettings?.width
          ? `${outputSettings.width}×${outputSettings.height} • ${outputFps}fps`
          : undefined,
      )}
      {row("OBS viewers", state.obsViewers)}
      {row(
        "Encoder",
        state.encoderLastMs !== undefined
          ? `${state.encoderLastMs}ms · ${Math.round((state.encoderLastBytes ?? 0) / 1024)}KB`
          : undefined,
      )}
      {row("JPEG q", state.encoderQuality !== undefined ? state.encoderQuality.toFixed(2) : undefined)}
      {row("Out W", state.encoderOutW)}
      {row("Path", state.encoderPath)}
      {row("In-flight", state.encoderInFlight)}
    </div>
  );
}
