import { useEffect, useRef } from "react";
import { Maximize2, Minimize2, Sparkles, Camera } from "lucide-react";

export type Orientation = "landscape" | "portrait";

interface Props {
  stream: MediaStream | null;
  label: string;
  mirrored?: boolean;
  isOutput?: boolean;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  isMinimized?: boolean;
  orientation?: Orientation;
  /** When true, the <video> stops decoding/painting (saves GPU). The track stays alive. */
  paused?: boolean;
}

export function VideoDisplay({
  stream,
  label,
  mirrored = false,
  isOutput = false,
  isExpanded = false,
  onToggleExpand,
  isMinimized = false,
  orientation = "landscape",
  paused = false,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (stream && !paused) {
      if (v.srcObject !== stream) v.srcObject = stream;
      // Chromium-only: hint a low playout buffer for snappier output preview.
      // Safe no-op elsewhere. Only meaningful for the AI output (WebRTC).
      if (isOutput) {
        try {
          (v as any).playoutDelayHint = 0.05;
        } catch {}
      }
      v.play().catch(() => {});
    } else if (paused) {
      // Detach so the decoder pipeline goes idle. Track is unaffected.
      try {
        v.pause();
      } catch {}
      v.srcObject = null;
    }
  }, [stream, paused, isOutput]);

  const aspectClass = orientation === "portrait" ? "aspect-[9/16]" : "aspect-video";

  if (isMinimized) {
    return (
      <div
        className="absolute bottom-4 right-4 z-20 w-48 rounded-lg overflow-hidden border border-border shadow-lg cursor-pointer hover:scale-105 transition-transform"
        onClick={onToggleExpand}
        style={{ contain: "layout paint", contentVisibility: "auto" as any }}
      >
        <div className={`${aspectClass} bg-muted/20 relative`}>
          {stream && !paused ? (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className={`w-full h-full object-cover ${mirrored ? "scale-x-[-1]" : ""}`}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              <Camera className="w-6 h-6" strokeWidth={1.5} />
            </div>
          )}
        </div>
        <div className="px-2 py-1 text-[10px] font-heading font-semibold tracking-wider uppercase bg-muted/50 text-muted-foreground">
          {label}
        </div>
      </div>
    );
  }

  return (
    <div className={`relative rounded-xl overflow-hidden ${isOutput ? "border-2 border-primary/50" : "border border-border"} ${isExpanded ? "h-full" : ""}`}>
      <div className={`${isExpanded ? "h-full" : aspectClass} bg-muted/20 relative`}>
        {stream && !paused ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted={!isOutput}
            preload="none"
            controls={false}
            disablePictureInPicture
            disableRemotePlayback
            className={`w-full h-full ${isOutput ? "object-contain" : "object-cover"} ${mirrored ? "scale-x-[-1]" : ""}`}
            style={
              isOutput
                ? {
                    transform: mirrored ? "translateZ(0) scaleX(-1)" : "translateZ(0)",
                    backfaceVisibility: "hidden",
                    imageRendering: "auto",
                  }
                : undefined
            }
          />
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <div className="flex justify-center mb-2 text-muted-foreground">
                {isOutput ? <Sparkles className="w-8 h-8" strokeWidth={1.5} /> : <Camera className="w-8 h-8" strokeWidth={1.5} />}
              </div>
              <p className="text-muted-foreground text-sm">
                {paused
                  ? "Preview paused"
                  : isOutput
                  ? "Transformed feed will appear here"
                  : "Camera feed will appear here"}
              </p>
            </div>
          </div>
        )}
        {/* Per-frame scanline overlay removed — it forced the compositor to
            re-rasterize the video texture every frame on iGPUs. */}
        {isOutput && onToggleExpand && (
          <button
            onClick={onToggleExpand}
            className="absolute top-3 right-3 z-10 p-2 rounded-lg bg-background/70 hover:bg-background/90 text-foreground transition-colors backdrop-blur-sm border border-border/50"
            title={isExpanded ? "Exit fullscreen" : "Expand output"}
          >
            {isExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
        )}
      </div>
      {!isExpanded && (
        <div className={`
          px-3 py-1.5 text-xs font-heading font-semibold tracking-wider uppercase
          ${isOutput
            ? "bg-primary/10 text-primary"
            : "bg-muted/50 text-muted-foreground"
          }
        `}>
          <div className="flex items-center gap-2">
            {stream && (
              <span className={`w-2 h-2 rounded-full ${isOutput ? "bg-primary animate-pulse-neon" : "bg-success"}`} />
            )}
            {label}
          </div>
        </div>
      )}
    </div>
  );
}
