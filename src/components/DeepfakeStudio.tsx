import { useState, useRef, useCallback, useEffect } from "react";
import { useDecartRealtime } from "@/hooks/useDecartRealtime";
import { VideoDisplay, type Orientation } from "./VideoDisplay";
import { CharacterPresets } from "./CharacterPresets";
import { CryptoPayment } from "./CryptoPayment";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useLocation } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { obsRelayTopic } from "@/lib/obsTopic";
import { Monitor, Smartphone, Copy, Download, GripVertical, Zap } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { ReviewPromptModal } from "./dashboard/ReviewPromptModal";
import { StudioDiagnostics, type DiagnosticsState } from "./StudioDiagnostics";
import { StudioCountdown } from "./StudioCountdown";
import { scoreImage } from "@/lib/referenceImageGate";
import { enhanceImage } from "@/lib/referenceImageEnhance";
import { buildPromptWithIdentityGuard } from "@/lib/lucyPromptGuard";
import { DecartStudioEngine } from "@/lib/decartStudioEngine";
import { ReferenceBlockedDialog } from "./studio/ReferenceBlockedDialog";
import { PhotoTipsPopover } from "./studio/PhotoTipsPopover";

// Feature flag — flip to false if thresholds prove too strict in production.
const REFERENCE_GATE_ENABLED = true;

export function DeepfakeStudio() {
  const [apiKey, setApiKey] = useState("");
  
  const didPrefillKeyRef = useRef(false);
  const [showPayment, setShowPayment] = useState(false);
  const [isStarted, setIsStarted] = useState(false);
  const [isLaunching, setIsLaunching] = useState(false);
  const [customPrompt, setCustomPrompt] = useState("");
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [referenceImage, setReferenceImage] = useState<File | null>(null);
  const [referencePreview, setReferencePreview] = useState<string | null>(null);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  // Optional textual hints that reinforce hair + outfit transfer from the
  // reference image. Merged into the prompt before the identity-lock suffix
  // that useDecartRealtime appends. Empty = current behavior.
  const [hairHint, setHairHint] = useState("");
  const [outfitHint, setOutfitHint] = useState("");
  const [outputExpanded, setOutputExpanded] = useState(false);
  const [orientation, setOrientation] = useState<Orientation>("landscape");
  // Mirror for the long-lived encoder loops (broker MSTP/bitmap, P2P pump).
  // They read this on every frame to know whether to crop to portrait.
  const orientationRef = useRef<Orientation>("landscape");
  useEffect(() => { orientationRef.current = orientation; }, [orientation]);
  // Notifier registries — each long-lived broadcast effect (broker + P2P)
  // installs a callback here so it gets pinged when the user flips orientation
  // mid-broadcast. Avoids re-running the effect (which would reset transport).
  const orientationListenersRef = useRef<Set<() => void>>(new Set());
  useEffect(() => {
    for (const cb of orientationListenersRef.current) {
      try { cb(); } catch (e) { console.warn("[obs] orientation notify failed", e); }
    }
  }, [orientation]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Tracks which reference File has already been pushed to Decart, so the
  // auto-apply-on-connect effect doesn't re-send the same image on every
  // reconnect / state flicker.
  const appliedReferenceRef = useRef<File | null>(null);

  const [timerAnchor, setTimerAnchor] = useState<{ remainingMs: number; perf: number } | null>(null);
  const [isFreeTrial, setIsFreeTrial] = useState(false);
  const [showTrialEnded, setShowTrialEnded] = useState(false);
  const [autoStartPending, setAutoStartPending] = useState(false);
  // OBS broadcast is opt-in to save CPU/RAM for the 99% of users who don't stream.
  const [obsEnabled, setObsEnabled] = useState(false);
  // Live broadcast status surfaced in the OBS panel so users see when frames flow.
  const [obsViewerCount, setObsViewerCount] = useState(0);
  // Active broadcast codec ("h264" or "jpeg") + rolling encode latency, for telemetry.
  const [obsCodec, setObsCodec] = useState<"h264" | "jpeg" | null>(null);
  const [obsEncodeMs, setObsEncodeMs] = useState<number | null>(null);
  const [obsBitrateKbps, setObsBitrateKbps] = useState<number | null>(null);
  // Transport mode: "p2p" (RTCDataChannel) or "broker" (Supabase Realtime).
  // Plan M lets the studio establish a direct WebRTC link to the OBS tab so
  // video bytes never round-trip through Supabase. Falls back automatically.
  const [obsTransport, setObsTransport] = useState<"p2p" | "broker" | null>(null);
  // True glass-to-glass latency, measured via DataChannel echo. P2P only.
  const [obsLatencyMs, setObsLatencyMs] = useState<number | null>(null);
  // Stable ref so the OBS effect doesn't tear down on apiKey changes.
  const apiKeyRef = useRef("");
  useEffect(() => { apiKeyRef.current = apiKey; }, [apiKey]);
  // Per-session lock token so we never release a key another tab has taken.
  const sessionIdRef = useRef<string | null>(null);
  // Mirror of sessionIdRef as React state so a single top-level effect can
  // manage the heartbeat interval regardless of which connect code path
  // opened the session. This is the sole source of truth for heartbeats.
  const [sessionIdState, setSessionIdState] = useState<string | null>(null);
  const setSession = (id: string | null) => {
    sessionIdRef.current = id;
    setSessionIdState(id);
  };
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Single source of truth for the studio heartbeat. Fires the instant a
  // session id exists (any connect code path) so `last_heartbeat_at` starts
  // advancing immediately and the server-side reaper cannot mistakenly close
  // a live session as `orphaned_auto`.
  useEffect(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    if (!sessionIdState) return;
    const key = (apiKeyRef.current || "").trim();
    if (!key) return;
    let cancelled = false;
    const sendBeat = async () => {
      const sid = sessionIdRef.current;
      if (!sid || cancelled) return;
      try {
        const { data, error } = await supabase.rpc(
          "heartbeat_studio_session",
          { p_key: key, p_session_id: sid } as any,
        );
        if (error) {
          console.warn("[Studio] heartbeat error:", error.message);
          try { await supabase.auth.getSession(); } catch { /* noop */ }
        } else if (data === false && !cancelled) {
          console.warn("[Studio] heartbeat returned false — session no longer live");
        }
      } catch (e) {
        console.warn("[Studio] heartbeat threw:", e);
      }
    };
    // Fire immediately so `first_heartbeat_at` is stamped before the reaper's
    // next tick, then keep a fast cadence to keep `last_heartbeat_at` fresh.
    void sendBeat();
    heartbeatRef.current = setInterval(() => { void sendBeat(); }, 1500);
    return () => {
      cancelled = true;
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    };
  }, [sessionIdState]);
  const handleDisconnectRef = useRef<() => void>(() => {});
  // Timestamp of the last successful teardown. Used to insert a small settle
  // delay before the next connect so the browser can finish releasing the
  // camera + closing the previous RTCPeerConnection.
  const lastDisconnectAtRef = useRef<number>(0);
  const { toast } = useToast();
  const { user } = useAuth();
  const location = useLocation();
  const [showReviewPrompt, setShowReviewPrompt] = useState(false);
  const debugMode =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("debug") === "1";
  const [diagnostics, setDiagnostics] = useState<DiagnosticsState>({});
  const [studioMode, setStudioMode] = useState<"preview" | "live">(() => {
    if (typeof window === "undefined") return "live";
    try {
      return (localStorage.getItem("elite-studio-mode") as "preview" | "live" | null) || "live";
    } catch {
      return "live";
    }
  });
  const studioEngineRef = useRef<DecartStudioEngine | null>(null);
  useEffect(() => {
    studioEngineRef.current = new DecartStudioEngine({
      apiKey: apiKey || import.meta.env.VITE_DECART_API_KEY || "",
      mode: studioMode,
      enableFallback: true,
    });
  }, [apiKey, studioMode]);

  useEffect(() => {
    try {
      localStorage.setItem("elite-studio-mode", studioMode);
    } catch {}
  }, [studioMode]);

  // Lite mode: auto-on for weak hardware (<=4 cores or <=4GB RAM) or ?lite=1.
  // User can override via header pill; choice persists in localStorage.
  const [liteMode, setLiteMode] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      const saved = localStorage.getItem("elite-lite-mode");
      if (saved === "1") return true;
      if (saved === "0") return false;
    } catch {}
    const params = new URLSearchParams(window.location.search);
    if (params.get("lite") === "1") return true;
    if (params.get("hi") === "1") return false;
    const cores = navigator.hardwareConcurrency ?? 8;
    const mem = (navigator as any).deviceMemory ?? 8;
    // Auto-lite only for genuinely weak hardware. Mid-range 8GB / 4-core
    // laptops stay on the standard rung so lip sync frame rate is preserved.
    return mem <= 2 || (cores <= 4 && mem <= 4);
  });
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.classList.toggle("lite-mode", liteMode);
  }, [liteMode]);
  const toggleLiteMode = useCallback(() => {
    setLiteMode((prev) => {
      const next = !prev;
      try { localStorage.setItem("elite-lite-mode", next ? "1" : "0"); } catch {}
      return next;
    });
  }, []);

  // Restore the user's OBS preference per-key (set after handleStart commits).
  useEffect(() => {
    if (!apiKey) return;
    try {
      const saved = localStorage.getItem(`obs-enabled-${apiKey}`);
      if (saved === "1") setObsEnabled(true);
    } catch {}
  }, [apiKey]);

  // Review prompt: show once after 60s of studio use, only for paid users with no review yet
  useEffect(() => {
    if (!user) return;
    const dismissedKey = `review-prompt-dismissed-${user.id}`;
    if (localStorage.getItem(dismissedKey)) return;

    const timer = setTimeout(async () => {
      try {
        // Eligibility: must be a paying user
        const { data: payments } = await supabase
          .from("payments")
          .select("id, created_at")
          .eq("user_id", user.id)
          .eq("status", "confirmed")
          .limit(1);
        if (!payments || payments.length === 0) return;

        // Don't prompt if a review already exists
        const { count } = await supabase
          .from("reviews")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id);
        if ((count ?? 0) > 0) return;

        setShowReviewPrompt(true);
      } catch {
        // silent
      }
    }, 60000);

    return () => clearTimeout(timer);
  }, [user]);

  // Auto-fill of the access key has been removed by request — every user must
  // paste their key manually each time they launch the studio.

  // Called by <StudioCountdown> when the timer reaches zero. Hard-stops the
  // session and force-deactivates the API key so it can't be reused.
  const handleExpire = useCallback(async () => {
    if (isFreeTrial) {
      setShowTrialEnded(true);
    } else {
      toast({ title: "API key expired ⏰", description: "Your session time has run out.", variant: "destructive" });
    }
    try {
      await supabase
        .from("api_keys")
        .update({ is_active: false, remaining_ms: 0, expires_at: null } as any)
        .eq("key", apiKey);
    } catch {}
    handleDisconnectRef.current();
  }, [isFreeTrial, toast, apiKey]);

  // Broadcast output frames to OBS via Supabase Realtime — presence-gated.
  // Strategy:
  //   1. Spin up the encoder Worker (always — it does both H.264 and JPEG).
  //   2. Wait for the OBS viewer to advertise its decoder capability via
  //      presence (`{ h264: true }` for Chromium with WebCodecs).
  //   3. Init the worker in the matching mode.
  //   4. Pipe MSTP VideoFrames straight into the worker; receiver reassembles.
  useEffect(() => {
    if (!remoteStream || !obsEnabled) return;
    const apiKey = apiKeyRef.current;
    if (!apiKey) return;

    const channelName = obsRelayTopic(apiKey);
    const channel = supabase.channel(channelName, {
      config: {
        broadcast: { self: false, ack: false },
        presence: { key: `studio-${Math.random().toString(36).slice(2, 10)}` },
      },
    });

    // Always try to spin up the worker — it handles both codecs.
    let worker: Worker | null = null;
    let canUseWorker = false;
    try {
      if (typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap === "function") {
        worker = new Worker(new URL("../workers/obsEncoder.worker.ts", import.meta.url), {
          type: "module",
        });
        canUseWorker = true;
      }
    } catch (e) {
      console.warn("OBS encoder worker unavailable, using main-thread fallback:", e);
      canUseWorker = false;
    }

    // Feature-detect Chromium MediaStreamTrackProcessor for direct VideoFrame piping.
    const MSTP = (window as any).MediaStreamTrackProcessor;
    const useTrackProcessor = canUseWorker && typeof MSTP === "function";
    // Sender-side WebCodecs availability — without VideoEncoder we can't do H.264.
    const senderCanH264 = typeof (globalThis as any).VideoEncoder === "function";

    // Lazy <video> for the bitmap fallback (Safari/Firefox).
    let video: HTMLVideoElement | null = null;
    let fallbackCanvas: HTMLCanvasElement | null = null;
    let fallbackCtx: CanvasRenderingContext2D | null = null;
    const ensureFallbackVideo = () => {
      if (video) return video;
      video = document.createElement("video");
      video.srcObject = remoteStream;
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      video.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";
      document.body.appendChild(video);
      fallbackCanvas = document.createElement("canvas");
      fallbackCtx = fallbackCanvas.getContext("2d");
      return video;
    };

    let running = true;
    // Pipeline depth: 2 frames in flight max (encoding + sending).
    let inFlight = 0;
    const MAX_IN_FLIGHT = 2;
    let viewerCount = 0;
    let nextId = 1;
    // Codec state — flips from "jpeg" to "h264" once the worker confirms ready.
    let codec: "h264" | "jpeg" = "jpeg";
    // Telemetry — rolling EMA of encoder latency reported by the worker.
    let latencyEma = 30;
    // Periodic keyframe scheduler so newly-arrived OBS viewers can decode quickly.
    let lastKeyframeAt = 0;
    const KEYFRAME_INTERVAL_MS = 2000;
    // Adaptive bitrate state — only used in H.264 mode.
    let saturationStreak = 0;
    let bitrateKbps = 1500;

    // Orientation-aware encode size. Portrait crops the landscape source
    // to a 9:16 frame so OBS sees vertical video.
    const PORTRAIT_W = 480;
    const PORTRAIT_H = 854;
    const LANDSCAPE_W = 854;
    const LANDSCAPE_H = 480;
    const targetSize = () =>
      orientationRef.current === "portrait"
        ? { w: PORTRAIT_W, h: PORTRAIT_H }
        : { w: LANDSCAPE_W, h: LANDSCAPE_H };

    // Reusable crop canvas. We resize it on orientation change so portrait
    // and landscape don't fight over the same buffer.
    let cropCanvas: OffscreenCanvas | null = null;
    let cropCtx: OffscreenCanvasRenderingContext2D | null = null;
    const ensureCropCanvas = (w: number, h: number) => {
      if (!cropCanvas) {
        cropCanvas = new OffscreenCanvas(w, h);
        cropCtx = cropCanvas.getContext("2d", { alpha: false });
      } else if (cropCanvas.width !== w || cropCanvas.height !== h) {
        cropCanvas.width = w;
        cropCanvas.height = h;
      }
      return cropCtx;
    };

    /** Center-crop a source frame into a new VideoFrame at target size.
     *  Closes the source frame and returns a fresh one the caller owns. */
    const cropFrameToTarget = (frame: VideoFrame): VideoFrame | null => {
      const { w: tw, h: th } = targetSize();
      const sw = frame.displayWidth || frame.codedWidth;
      const sh = frame.displayHeight || frame.codedHeight;
      const ctx = ensureCropCanvas(tw, th);
      if (!ctx || !cropCanvas) { try { frame.close(); } catch {} return null; }
      const targetAR = tw / th;
      const srcAR = sw / sh;
      let sx = 0, sy = 0, scw = sw, sch = sh;
      if (srcAR > targetAR) {
        scw = Math.round(sh * targetAR);
        sx = Math.round((sw - scw) / 2);
      } else if (srcAR < targetAR) {
        sch = Math.round(sw / targetAR);
        sy = Math.round((sh - sch) / 2);
      }
      try {
        ctx.drawImage(frame as unknown as CanvasImageSource, sx, sy, scw, sch, 0, 0, tw, th);
      } catch {
        try { frame.close(); } catch {}
        return null;
      }
      const ts = frame.timestamp;
      try { frame.close(); } catch {}
      try {
        return new VideoFrame(cropCanvas, { timestamp: ts ?? 0 });
      } catch {
        return null;
      }
    };

    const setupWorker = (useH264: boolean) => {
      if (!worker) return;
      const { w, h } = targetSize();
      worker.postMessage({
        kind: "init",
        codec: useH264 ? "h264" : "jpeg",
        width: w,
        height: h,
        bitrate: bitrateKbps * 1000,
        framerate: 20,
      });
    };

    if (worker) {
      worker.onmessage = (e: MessageEvent) => {
        const m = e.data;
        if (!m) return;
        if (m.kind === "ready") {
          codec = m.codec;
          setObsCodec(m.codec);
          setObsBitrateKbps(m.codec === "h264" ? bitrateKbps : null);
          if (debugMode) console.log("[obs] worker ready, codec =", m.codec);
          return;
        }
        if (m.kind === "frame") {
          inFlight = Math.max(0, inFlight - 1);
          if (debugMode) {
            setDiagnostics((d) => ({
              ...d,
              encoderInFlight: inFlight,
              encoderLastBytes: m.bytes,
              encoderLastMs: m.encodeMs,
              encoderOutW: m.width,
            }));
          }
          if (m.error || !m.data) return;
          // Update telemetry EMA.
          latencyEma = 0.2 * m.encodeMs + 0.8 * latencyEma;
          setObsEncodeMs(Math.round(latencyEma));
          // Adaptive bitrate (H.264 only).
          if (codec === "h264") {
            if (inFlight >= MAX_IN_FLIGHT - 1) saturationStreak++;
            else saturationStreak = Math.max(0, saturationStreak - 1);
            // Drop bitrate aggressively when network is the bottleneck;
            // climb slowly when it's healthy.
            if (saturationStreak >= 30 && bitrateKbps > 800) {
              bitrateKbps = Math.max(800, bitrateKbps - 200);
              worker?.postMessage({ kind: "bitrate", bitrate: bitrateKbps * 1000 });
              setObsBitrateKbps(bitrateKbps);
              saturationStreak = 0;
            } else if (saturationStreak === 0 && bitrateKbps < 2500 && latencyEma < 8) {
              bitrateKbps = Math.min(2500, bitrateKbps + 100);
              worker?.postMessage({ kind: "bitrate", bitrate: bitrateKbps * 1000 });
              setObsBitrateKbps(bitrateKbps);
            }
          }
          // Broadcast. Keep the JSON small — single-letter keys.
          if (!running) return;
          channel
            .send({
              type: "broadcast",
              event: "frame",
              payload: {
                w: m.width,
                h: m.height,
                d: m.data,
                t: m.type, // "key" | "delta"
                ts: m.ts,
                ...(m.config ? { c: m.config } : {}),
              },
            })
            .catch(() => {});
        }
      };
    }

    // ---- Path A: Chromium fast path via MediaStreamTrackProcessor ----
    let reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
    let mstpFellBack = false;
    let blackStreak = 0;
    // N2: when broker viewers all leave (e.g. they all upgraded to P2P),
    // pause the MSTP read loop instead of pulling and closing every frame.
    // recomputeCodec resolves this promise the moment a broker viewer reappears.
    let viewersWaitResolve: (() => void) | null = null;
    let viewersWait: Promise<void> | null = null;
    const waitForBrokerViewers = () => {
      if (viewerCount > 0) return Promise.resolve();
      if (!viewersWait) {
        viewersWait = new Promise<void>((res) => { viewersWaitResolve = res; });
      }
      return viewersWait;
    };
    const wakeBrokerLoop = () => {
      if (viewersWaitResolve) {
        viewersWaitResolve();
        viewersWaitResolve = null;
        viewersWait = null;
      }
    };
    const runTrackProcessor = async () => {
      try {
        const track = remoteStream.getVideoTracks()[0];
        if (!track) return;
        const processor = new MSTP({ track });
        reader = processor.readable.getReader();
        if (debugMode) setDiagnostics((d) => ({ ...d, encoderPath: "frame" }));
        while (running && !mstpFellBack) {
          // N2: idle the loop while no broker viewers need frames. The MSTP
          // reader stays alive (cheap), but we stop pulling frames so the
          // browser doesn't allocate VideoFrames we'd just close.
          if (viewerCount === 0) {
            await waitForBrokerViewers();
            if (!running || mstpFellBack) break;
          }
          const { value: frame, done } = await reader!.read();
          if (done) break;
          if (!frame) continue;
          // Drop if backed up or no viewer (race: viewer may have left
          // between the wait and the read).
          if (viewerCount === 0 || inFlight >= MAX_IN_FLIGHT) {
            frame.close();
            continue;
          }
          const now = performance.now();
          const wantKey = now - lastKeyframeAt >= KEYFRAME_INTERVAL_MS;
          if (wantKey) lastKeyframeAt = now;

          // Portrait mode crops the landscape source to 9:16 before encoding.
          // Landscape stays on the zero-copy fast path.
          let outFrame: VideoFrame | null = frame;
          if (orientationRef.current === "portrait") {
            outFrame = cropFrameToTarget(frame); // closes original
            if (!outFrame) continue;
          }
          inFlight++;
          worker?.postMessage(
            {
              kind: "encode",
              id: nextId++,
              frame: outFrame,
              srcWidth: outFrame.displayWidth || outFrame.codedWidth,
              srcHeight: outFrame.displayHeight || outFrame.codedHeight,
              ts: now,
              keyFrame: wantKey,
            },
            [outFrame as unknown as Transferable],
          );
          // Drain telemetry roughly via worker replies — handled in onmessage.
          // We only check for the black-frame fallback when the JPEG path
          // surfaces it; with H.264, drawImage is bypassed entirely.
        }
      } catch (err) {
        console.warn("MediaStreamTrackProcessor failed, falling back:", err);
        if (!mstpFellBack) {
          mstpFellBack = true;
          runBitmapLoop();
        }
      }
    };

    // ---- Path B: hidden video + createImageBitmap (Safari/Firefox/no-MSTP) ----
    const runBitmapLoop = () => {
      const vid = ensureFallbackVideo();
      vid.play().catch(() => {});
      if (debugMode) setDiagnostics((d) => ({ ...d, encoderPath: canUseWorker ? "bitmap" : "main" }));
      const targetIntervalMs = 1000 / 20; // 20 fps for the bitmap path
      let lastSent = 0;
      const tick = () => {
        if (!running) return;
        if (viewerCount === 0) {
          setTimeout(tick, 500);
          return;
        }
        if (!vid.videoWidth || !vid.videoHeight) {
          setTimeout(tick, targetIntervalMs);
          return;
        }
        const now = performance.now();
        if (inFlight >= MAX_IN_FLIGHT || now - lastSent < targetIntervalMs) {
          setTimeout(tick, targetIntervalMs);
          return;
        }
        lastSent = now;
        inFlight++;
        const wantKey = now - lastKeyframeAt >= KEYFRAME_INTERVAL_MS;
        if (wantKey) lastKeyframeAt = now;
        setTimeout(tick, targetIntervalMs);
        (async () => {
          try {
            // Compute crop region for portrait, or full frame for landscape.
            const { w: tw, h: th } = targetSize();
            const vw = vid.videoWidth;
            const vh = vid.videoHeight;
            const targetAR = tw / th;
            const srcAR = vw / vh;
            let sx = 0, sy = 0, scw = vw, sch = vh;
            if (orientationRef.current === "portrait") {
              if (srcAR > targetAR) {
                scw = Math.round(vh * targetAR);
                sx = Math.round((vw - scw) / 2);
              } else if (srcAR < targetAR) {
                sch = Math.round(vw / targetAR);
                sy = Math.round((vh - sch) / 2);
              }
            }

            if (canUseWorker && worker) {
              const bitmap =
                orientationRef.current === "portrait"
                  ? await createImageBitmap(vid, sx, sy, scw, sch, {
                      resizeWidth: tw,
                      resizeHeight: th,
                      resizeQuality: "medium",
                    })
                  : await createImageBitmap(vid);
              worker.postMessage(
                {
                  kind: "encode",
                  id: nextId++,
                  bitmap,
                  srcWidth: bitmap.width,
                  srcHeight: bitmap.height,
                  ts: now,
                  keyFrame: wantKey,
                },
                [bitmap],
              );
            } else {
              // No worker at all — main-thread JPEG via 2D ctx.
              if (!fallbackCtx || !fallbackCanvas) {
                inFlight = Math.max(0, inFlight - 1);
                return;
              }
              const maxW = orientationRef.current === "portrait" ? tw : 854;
              const portrait = orientationRef.current === "portrait";
              const w = portrait ? tw : Math.round(vw * Math.min(1, maxW / vw));
              const h = portrait ? th : Math.round(vh * Math.min(1, maxW / vw));
              fallbackCanvas.width = w;
              fallbackCanvas.height = h;
              if (portrait) {
                fallbackCtx.drawImage(vid, sx, sy, scw, sch, 0, 0, w, h);
              } else {
                fallbackCtx.drawImage(vid, 0, 0, w, h);
              }
              const blob = await new Promise<Blob | null>((res) =>
                fallbackCanvas!.toBlob(res, "image/jpeg", 0.5),
              );
              if (!blob) throw new Error("toBlob failed");
              const buf = new Uint8Array(await blob.arrayBuffer());
              let s = "";
              const CHUNK = 0x8000;
              for (let i = 0; i < buf.length; i += CHUNK) {
                s += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK) as unknown as number[]);
              }
              const data = btoa(s);
              inFlight = Math.max(0, inFlight - 1);
              if (running) {
                channel.send({
                  type: "broadcast",
                  event: "frame",
                  payload: { w, h, d: data, t: "key", ts: now },
                }).catch(() => {});
              }
            }
          } catch (err) {
            inFlight = Math.max(0, inFlight - 1);
            if (debugMode) console.warn("encode error (bitmap)", err);
          }
        })();
      };
      tick();
    };

    // Capability negotiation: whenever presence syncs, see whether ALL viewers
    // can decode H.264. If yes, use it; otherwise stick with JPEG.
    const recomputeCodec = () => {
      const state = channel.presenceState() as Record<
        string,
        Array<{ role?: string; h264?: boolean; viewerId?: string; servingViewers?: string[] }>
      >;
      const flat = Object.values(state).flat();
      // Plan M: viewers being served via P2P don't count toward the broker
      // viewer set — they receive bytes via DataChannel directly.
      const p2pServed = new Set<string>();
      for (const entry of flat) {
        if (entry?.role === "studio-p2p" && Array.isArray(entry.servingViewers)) {
          for (const id of entry.servingViewers) p2pServed.add(id);
        }
      }
      const allViewers = flat.filter((p) => p?.role === "viewer");
      const brokerViewers = allViewers.filter(
        (v) => !v.viewerId || !p2pServed.has(v.viewerId),
      );
      // Badge shows total viewers (P2P + broker); broker frame loop only
      // serves the broker subset.
      setObsViewerCount(allViewers.length);
      const prevBrokerCount = viewerCount;
      viewerCount = brokerViewers.length;
      // N2: if broker viewers reappeared while the loop was idling, wake it.
      if (prevBrokerCount === 0 && viewerCount > 0) wakeBrokerLoop();
      const allBrokerH264 = brokerViewers.length > 0 && brokerViewers.every((v) => v?.h264 === true);
      const useH264 = senderCanH264 && allBrokerH264;
      const wantedCodec: "h264" | "jpeg" = useH264 ? "h264" : "jpeg";
      if (wantedCodec !== codec && brokerViewers.length > 0) {
        if (debugMode) console.log("[obs] broker switching codec to", wantedCodec);
        codec = wantedCodec;
        lastKeyframeAt = 0; // force keyframe on next encode
        setupWorker(useH264);
      }
      if (debugMode) setDiagnostics((d) => ({ ...d, obsViewers: viewerCount }));
    };

    channel.on("presence", { event: "sync" }, recomputeCodec);

    // Reconfigure the worker encoder when the user flips orientation mid-broadcast.
    // The worker rebuilds H.264 at the new size and emits a fresh avcC on the
    // next keyframe; receivers detect the size change and re-init their decoder.
    const onOrientationChange = () => {
      if (!worker) return;
      const { w, h } = targetSize();
      worker.postMessage({ kind: "reconfigure", width: w, height: h });
      lastKeyframeAt = 0; // force keyframe on next encode
    };
    orientationListenersRef.current.add(onOrientationChange);

    channel.subscribe((s) => {
      if (s === "SUBSCRIBED") {
        // Start in JPEG mode; recomputeCodec will upgrade to H.264 once a
        // viewer arrives that advertises support.
        setupWorker(false);
        if (useTrackProcessor) runTrackProcessor();
        else runBitmapLoop();
      }
    });

    return () => {
      running = false;
      // N2: unblock the MSTP loop's await so it can exit promptly.
      wakeBrokerLoop();
      orientationListenersRef.current.delete(onOrientationChange);
      setObsViewerCount(0);
      setObsCodec(null);
      setObsEncodeMs(null);
      setObsBitrateKbps(null);
      try {
        reader?.cancel();
      } catch {}
      if (worker) worker.terminate();
      cropCanvas = null;
      cropCtx = null;
      try {
        video?.pause();
      } catch {}
      if (video) {
        video.srcObject = null;
        try { video.parentNode?.removeChild(video); } catch {}
      }
      supabase.removeChannel(channel);
    };
  }, [remoteStream, obsEnabled, debugMode]);

  // ===========================================================================
  // P2P transport (Plan M+N) — direct WebRTC DataChannel for video bytes.
  //
  // Architecture (post-Plan-N):
  //   • One MediaStreamTrackProcessor reader for the whole studio.
  //   • One VideoEncoder for the whole studio. Output is fanned out to every
  //     open peer's DataChannel as the same ArrayBuffer (no re-encode per peer).
  //   • One RTCPeerConnection per viewer (mandatory — DataChannels can't be
  //     shared across PCs).
  //   • One pre-warmed RTCPeerConnection that starts ICE gathering the moment
  //     `obsEnabled` flips on, so the first viewer's first frame arrives ~200ms
  //     sooner than starting from scratch on viewer-presence.
  //
  // Backpressure (per peer):
  //   bufferedAmount > 256 KB → mark sendPaused, request keyframe, skip sends
  //   bufferedAmountLow event → clear sendPaused, resume immediately
  //
  // Keyframes:
  //   The encoder picks its own IDR cadence (Chromium ≈ every 60 frames in
  //   realtime mode). We force a keyframe ONLY on:
  //     - any peer's `dc.onopen` (so they can start decoding within ~33 ms)
  //     - any peer recovering from backpressure
  //   No more periodic 2 s app-driven IDRs → no more periodic bitrate spikes
  //   → no more periodic dropped P-frames.
  //
  // The broker effect above stays subscribed and acts as:
  //   1. signaling channel (SDP offer/answer + ICE),
  //   2. universal fallback for viewers where P2P doesn't open within 3 s.
  // ===========================================================================
  useEffect(() => {
    if (!remoteStream || !obsEnabled) return;
    const apiKey = apiKeyRef.current;
    if (!apiKey) return;

    // Sender requires WebCodecs (for in-place H.264 encode) and MSTP
    // (for direct VideoFrame access). Without either, broker is the best we have.
    const MSTP = (window as any).MediaStreamTrackProcessor;
    const hasMSTP = typeof MSTP === "function";
    const hasEncoder = typeof (globalThis as any).VideoEncoder === "function";
    if (!hasMSTP || !hasEncoder) {
      if (debugMode) console.log("[p2p] skipping — sender lacks MSTP/VideoEncoder");
      return;
    }

    let cancelled = false;
    let cleanupFns: Array<() => void> = [];

    // Lazy-load to keep the initial bundle slim.
    (async () => {
      const {
        encodeBinaryFrame,
        FLAG_KEYFRAME,
        DEFAULT_ICE_SERVERS,
        newPeerId,
      } = await import("@/lib/obsP2P");
      if (cancelled) return;

      const senderId = newPeerId();
      const signalingChannel = supabase.channel(obsRelayTopic(apiKey), {
        config: { broadcast: { self: false, ack: false } },
      });
      cleanupFns.push(() => supabase.removeChannel(signalingChannel));

      // ---- Shared encoder state ----
      const LANDSCAPE = { w: 854, h: 480 };
      const PORTRAIT = { w: 480, h: 854 };
      // Mutable so an orientation flip can rebuild the encoder at the new size.
      let encW = orientationRef.current === "portrait" ? PORTRAIT.w : LANDSCAPE.w;
      let encH = orientationRef.current === "portrait" ? PORTRAIT.h : LANDSCAPE.h;
      const BACKPRESSURE_HIGH = 256 * 1024;
      const BACKPRESSURE_LOW = 64 * 1024;

      // Crop canvas reused across frames in portrait mode. Recreated on size change.
      let p2pCropCanvas: OffscreenCanvas | null = null;
      let p2pCropCtx: OffscreenCanvasRenderingContext2D | null = null;
      const ensureP2PCrop = (w: number, h: number) => {
        if (!p2pCropCanvas) {
          p2pCropCanvas = new OffscreenCanvas(w, h);
          p2pCropCtx = p2pCropCanvas.getContext("2d", { alpha: false });
        } else if (p2pCropCanvas.width !== w || p2pCropCanvas.height !== h) {
          p2pCropCanvas.width = w;
          p2pCropCanvas.height = h;
        }
        return p2pCropCtx;
      };
      /** Center-crop into a new VideoFrame at (encW, encH). Closes the source. */
      const cropP2PFrame = (frame: VideoFrame): VideoFrame | null => {
        const sw = frame.displayWidth || frame.codedWidth;
        const sh = frame.displayHeight || frame.codedHeight;
        const ctx = ensureP2PCrop(encW, encH);
        if (!ctx || !p2pCropCanvas) { try { frame.close(); } catch {} return null; }
        const targetAR = encW / encH;
        const srcAR = sw / sh;
        let sx = 0, sy = 0, scw = sw, sch = sh;
        if (srcAR > targetAR) {
          scw = Math.round(sh * targetAR);
          sx = Math.round((sw - scw) / 2);
        } else if (srcAR < targetAR) {
          sch = Math.round(sw / targetAR);
          sy = Math.round((sh - sch) / 2);
        }
        try {
          ctx.drawImage(frame as unknown as CanvasImageSource, sx, sy, scw, sch, 0, 0, encW, encH);
        } catch {
          try { frame.close(); } catch {}
          return null;
        }
        const ts = frame.timestamp;
        try { frame.close(); } catch {}
        try {
          return new VideoFrame(p2pCropCanvas, { timestamp: ts ?? 0 });
        } catch {
          return null;
        }
      };

      let sharedEncoder: VideoEncoder | null = null;
      let sharedEncoderConfig: Uint8Array | null = null;
      let sharedReader: ReadableStreamDefaultReader<VideoFrame> | null = null;
      let pumpRunning = false;
      // Any peer can request a forced keyframe on the next encode (e.g. on
      // dc.onopen or after backpressure). We OR all requests together.
      let forceKeyframePending = false;

      type Peer = {
        viewerId: string;
        pc: RTCPeerConnection;
        dc: RTCDataChannel | null;
        running: boolean;
        opened: boolean;
        sendPaused: boolean;
        // True until we've successfully sent a keyframe to this peer. Until
        // then, P-frames for this peer are dropped (they'd be undecodable).
        awaitingKeyframe: boolean;
        timeoutHandle: ReturnType<typeof setTimeout> | null;
      };
      const peers = new Map<string, Peer>();

      // ---- Pre-warmed PC: starts ICE gathering immediately, gets promoted to
      //      the first viewer's PC when one arrives. (Plan N5)
      let warmedPc: RTCPeerConnection | null = null;
      let warmedDc: RTCDataChannel | null = null;
      const createWarmedPc = () => {
        try {
          const pc = new RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS });
          const dc = pc.createDataChannel("video", { ordered: false, maxRetransmits: 0 });
          dc.binaryType = "arraybuffer";
          warmedPc = pc;
          warmedDc = dc;
          // Kick off ICE gathering by creating a local offer (we don't send it).
          void pc.createOffer().then((offer) => pc.setLocalDescription(offer)).catch(() => {});
          if (debugMode) console.log("[p2p] warmed PC pre-gathering ICE");
        } catch (err) {
          if (debugMode) console.warn("[p2p] warmed PC create failed", err);
          warmedPc = null;
          warmedDc = null;
        }
      };
      createWarmedPc();

      // ---- Encoder lifecycle ----
      const setupEncoder = () => {
        if (sharedEncoder) return;
        try {
          sharedEncoder = new VideoEncoder({
            output: (chunk, meta) => {
              // Cache decoder config on first emit (avcC bytes).
              if (meta?.decoderConfig?.description && !sharedEncoderConfig) {
                const desc = meta.decoderConfig.description as ArrayBuffer | ArrayBufferView;
                sharedEncoderConfig = desc instanceof ArrayBuffer
                  ? new Uint8Array(desc)
                  : new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength);
              }
              const buf = new Uint8Array(chunk.byteLength);
              chunk.copyTo(buf);
              const isKey = chunk.type === "key";
              const tsRel = Math.round((chunk.timestamp ?? 0) / 1000);
              const wire = encodeBinaryFrame({
                flags: isKey ? FLAG_KEYFRAME : 0,
                ts: tsRel,
                width: encW,
                height: encH,
                config: isKey ? sharedEncoderConfig ?? undefined : undefined,
                data: buf,
              });

              // Fan out to every open peer.
              for (const peer of peers.values()) {
                const dc = peer.dc;
                if (!dc || dc.readyState !== "open" || !peer.running) continue;

                // Peer needs a keyframe before it can decode anything.
                if (peer.awaitingKeyframe && !isKey) continue;

                // Per-peer backpressure: if the SCTP buffer is full, skip this
                // chunk. The bufferedamountlow listener will clear sendPaused.
                if (peer.sendPaused) continue;
                if (dc.bufferedAmount > BACKPRESSURE_HIGH) {
                  peer.sendPaused = true;
                  // After a backpressure event we need a fresh keyframe to
                  // resume decoding cleanly.
                  peer.awaitingKeyframe = true;
                  forceKeyframePending = true;
                  continue;
                }

                try {
                  dc.send(wire);
                  if (isKey) peer.awaitingKeyframe = false;
                } catch {
                  // Send failed — request a keyframe for next round.
                  peer.awaitingKeyframe = true;
                  forceKeyframePending = true;
                }
              }
            },
            error: (err) => {
              console.warn("[p2p] shared encoder error", err);
              try { sharedEncoder?.close(); } catch {}
              sharedEncoder = null;
              sharedEncoderConfig = null;
              // Force every still-open peer to expect a keyframe on the
              // next-encoder rebuild.
              for (const p of peers.values()) {
                p.awaitingKeyframe = true;
              }
              forceKeyframePending = true;
              // Try to rebuild lazily on next pump tick.
              setupEncoder();
            },
          });
          sharedEncoder.configure({
            codec: "avc1.42E01F",
            width: encW,
            height: encH,
            bitrate: 1_500_000,
            framerate: 20,
            latencyMode: "realtime",
            hardwareAcceleration: "prefer-hardware",
            avc: { format: "avc" },
          });
        } catch (err) {
          console.warn("[p2p] shared encoder configure failed", err);
          try { sharedEncoder?.close(); } catch {}
          sharedEncoder = null;
        }
      };

      // ---- Pump: pulls VideoFrames and feeds the shared encoder. Only runs
      //      while at least one peer is open. Otherwise idles to save CPU. ----
      const startPumpIfNeeded = async () => {
        if (pumpRunning) return;
        // Only run the pump once at least one peer is open.
        const anyOpen = Array.from(peers.values()).some((p) => p.opened && p.running);
        if (!anyOpen) return;

        pumpRunning = true;
        if (!sharedEncoder) setupEncoder();
        if (!sharedReader) {
          try {
            const track = remoteStream.getVideoTracks()[0];
            if (!track) { pumpRunning = false; return; }
            const processor = new MSTP({ track });
            sharedReader = processor.readable.getReader();
          } catch (err) {
            console.warn("[p2p] MSTP reader create failed", err);
            pumpRunning = false;
            return;
          }
        }

        if (debugMode) console.log("[p2p] shared pump starting");
        try {
          while (pumpRunning) {
            const stillNeeded = Array.from(peers.values()).some((p) => p.opened && p.running);
            if (!stillNeeded) break;
            const { value: frame, done } = await sharedReader.read();
            if (done) break;
            if (!frame) continue;
            if (!sharedEncoder || sharedEncoder.state !== "configured") {
              frame.close();
              continue;
            }
            // Portrait: crop the source to 9:16 before encoding (closes original).
            // Landscape: zero-copy fast path (frame goes straight to encoder).
            let encFrame: VideoFrame | null = frame;
            if (orientationRef.current === "portrait") {
              encFrame = cropP2PFrame(frame);
              if (!encFrame) continue;
            }
            const wantKey = forceKeyframePending;
            if (wantKey) forceKeyframePending = false;
            try {
              sharedEncoder.encode(encFrame, { keyFrame: wantKey });
            } catch (err) {
              if (debugMode) console.warn("[p2p] encode threw", err);
            } finally {
              try { encFrame.close(); } catch {}
            }
          }
        } catch (err) {
          if (debugMode) console.warn("[p2p] pump loop error", err);
        } finally {
          pumpRunning = false;
          if (debugMode) console.log("[p2p] shared pump stopped");
        }
      };

      const tearDownPeer = (viewerId: string, reason: string) => {
        const p = peers.get(viewerId);
        if (!p) return;
        peers.delete(viewerId);
        p.running = false;
        if (p.timeoutHandle) clearTimeout(p.timeoutHandle);
        try { p.dc?.close(); } catch {}
        try { p.pc.close(); } catch {}
        if (debugMode) console.log("[p2p] teardown viewer", viewerId, reason);
        if (peers.size === 0) {
          setObsTransport((t) => (t === "p2p" ? null : t));
          setObsLatencyMs(null);
          // No peers left → stop the pump to save CPU. Encoder stays
          // configured for the next viewer.
          pumpRunning = false;
        }
      };

      // ---- Wire up an existing PC+DC into a Peer (used both for new PCs and
      //      for promoting the warmed PC). ----
      const wireUpPeer = (peer: Peer) => {
        const { pc, dc, viewerId } = peer;
        if (!dc) return;

        // bufferedAmountLowThreshold + onbufferedamountlow gives us instant
        // resume when the SCTP buffer drains, without polling per encoded chunk.
        try { dc.bufferedAmountLowThreshold = BACKPRESSURE_LOW; } catch {}
        dc.onbufferedamountlow = () => {
          peer.sendPaused = false;
          // Force a keyframe so the peer can resume decoding cleanly.
          peer.awaitingKeyframe = true;
          forceKeyframePending = true;
        };

        pc.onicecandidate = (e) => {
          if (e.candidate) {
            void signalingChannel.send({
              type: "broadcast",
              event: "p2p-signal",
              payload: {
                kind: "ice",
                candidate: e.candidate.toJSON(),
                from: senderId,
                to: viewerId,
              },
            });
          }
        };

        pc.onconnectionstatechange = () => {
          if (debugMode) console.log("[p2p] pc state", viewerId, pc.connectionState);
          if (pc.connectionState === "failed" || pc.connectionState === "closed") {
            tearDownPeer(viewerId, `pc-${pc.connectionState}`);
          }
        };

        dc.onopen = () => {
          peer.opened = true;
          peer.awaitingKeyframe = true;
          if (peer.timeoutHandle) clearTimeout(peer.timeoutHandle);
          if (debugMode) console.log("[p2p] dc opened for viewer", viewerId);
          setObsTransport("p2p");
          setObsCodec("h264");
          setObsBitrateKbps(1500);
          // Force a keyframe so this peer can start decoding immediately.
          forceKeyframePending = true;
          // Track presence so the broker effect knows to stop sending frames
          // for viewers that are now on P2P.
          void signalingChannel.track({
            role: "studio-p2p",
            id: senderId,
            servingViewers: Array.from(peers.keys()).filter((vid) => peers.get(vid)?.opened),
          });
          // Start the shared pump if it isn't already running.
          void startPumpIfNeeded();
        };

        dc.onclose = () => tearDownPeer(viewerId, "dc-close");
        dc.onerror = (e) => {
          if (debugMode) console.warn("[p2p] dc error", e);
        };
        // Receiver echoes back ts once per second for true latency measurement.
        dc.onmessage = (e) => {
          try {
            const msg = JSON.parse(typeof e.data === "string" ? e.data : "");
            if (msg?.kind === "latency-pong" && typeof msg.sentTs === "number") {
              const latency = performance.now() - msg.sentTs;
              setObsLatencyMs(Math.round(latency));
            }
          } catch {}
        };
      };

      // ---- Peer creation: promote the warmed PC for the first viewer; build
      //      a fresh PC for subsequent viewers (and warm a new one for the next). ----
      const ensurePeer = (viewerId: string): Peer => {
        const existing = peers.get(viewerId);
        if (existing) return existing;

        let pc: RTCPeerConnection;
        let dc: RTCDataChannel;
        if (warmedPc && warmedDc) {
          pc = warmedPc;
          dc = warmedDc;
          warmedPc = null;
          warmedDc = null;
          if (debugMode) console.log("[p2p] promoted warmed PC for viewer", viewerId);
          // Start warming the next one in the background for viewer #2.
          createWarmedPc();
        } else {
          pc = new RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS });
          dc = pc.createDataChannel("video", { ordered: false, maxRetransmits: 0 });
          dc.binaryType = "arraybuffer";
        }

        const peer: Peer = {
          viewerId,
          pc,
          dc,
          running: true,
          opened: false,
          sendPaused: false,
          awaitingKeyframe: true,
          timeoutHandle: null,
        };
        peers.set(viewerId, peer);

        // 3-second open timeout — if the channel isn't open by then, give up
        // and let this viewer fall through to the broker path.
        peer.timeoutHandle = setTimeout(() => {
          if (!peer.opened) {
            if (debugMode) console.warn("[p2p] open timeout for viewer", viewerId);
            tearDownPeer(viewerId, "open-timeout");
          }
        }, 3000);

        wireUpPeer(peer);
        return peer;
      };

      const startNegotiation = async (viewerId: string) => {
        const peer = ensurePeer(viewerId);
        try {
          // If this PC was just promoted from the warmed slot, it already has
          // a localDescription from the pre-warm offer. Re-create to get a
          // fresh offer that matches our current state. (Cheap; ICE candidates
          // are already cached by the agent so gathering is essentially instant.)
          const offer = await peer.pc.createOffer();
          await peer.pc.setLocalDescription(offer);
          await signalingChannel.send({
            type: "broadcast",
            event: "p2p-signal",
            payload: {
              kind: "offer",
              sdp: offer.sdp,
              from: senderId,
              to: viewerId,
            },
          });
        } catch (err) {
          console.warn("[p2p] offer failed", err);
          tearDownPeer(viewerId, "offer-failed");
        }
      };

      // Track viewers seen via presence; offer to any new ones that advertise p2p.
      const onPresenceSync = () => {
        const state = signalingChannel.presenceState() as Record<
          string,
          Array<{ role?: string; h264?: boolean; p2p?: boolean; viewerId?: string }>
        >;
        const viewers = Object.values(state)
          .flat()
          .filter((p) => p?.role === "viewer" && p?.p2p === true && p?.viewerId);
        for (const v of viewers) {
          const vid = v.viewerId!;
          if (!peers.has(vid)) {
            if (debugMode) console.log("[p2p] new viewer", vid);
            void startNegotiation(vid);
          }
        }
        // Drop peers whose viewer has gone away.
        const liveIds = new Set(viewers.map((v) => v.viewerId!));
        for (const vid of Array.from(peers.keys())) {
          if (!liveIds.has(vid)) tearDownPeer(vid, "viewer-left");
        }
      };

      signalingChannel.on("presence", { event: "sync" }, onPresenceSync);
      signalingChannel.on("broadcast", { event: "p2p-signal" }, async (msg) => {
        const p = msg.payload as any;
        if (!p || p.to !== senderId) return;
        const peer = peers.get(p.from);
        if (!peer && p.kind !== "answer") return;
        try {
          if (p.kind === "answer" && peer) {
            await peer.pc.setRemoteDescription({ type: "answer", sdp: p.sdp });
          } else if (p.kind === "ice" && peer) {
            try {
              await peer.pc.addIceCandidate(p.candidate);
            } catch (err) {
              if (debugMode) console.warn("[p2p] addIceCandidate failed", err);
            }
          }
        } catch (err) {
          console.warn("[p2p] signaling handler failed", err);
        }
      });

      signalingChannel.subscribe((s) => {
        if (s === "SUBSCRIBED") {
          if (debugMode) console.log("[p2p] signaling subscribed as", senderId);
        }
      });

      // Mid-broadcast orientation flip: rebuild encoder at new size, drop the
      // cached avcC, and force a keyframe so every peer's decoder re-inits.
      const onP2POrientationChange = () => {
        const next = orientationRef.current === "portrait" ? PORTRAIT : LANDSCAPE;
        if (next.w === encW && next.h === encH) return;
        encW = next.w;
        encH = next.h;
        try { sharedEncoder?.close(); } catch {}
        sharedEncoder = null;
        sharedEncoderConfig = null;
        for (const p of peers.values()) p.awaitingKeyframe = true;
        forceKeyframePending = true;
        // Pump will lazily call setupEncoder() on its next iteration.
      };
      orientationListenersRef.current.add(onP2POrientationChange);

      cleanupFns.push(() => {
        pumpRunning = false;
        orientationListenersRef.current.delete(onP2POrientationChange);
        for (const vid of Array.from(peers.keys())) tearDownPeer(vid, "effect-cleanup");
        try { sharedReader?.cancel(); } catch {}
        sharedReader = null;
        try { sharedEncoder?.close(); } catch {}
        sharedEncoder = null;
        sharedEncoderConfig = null;
        p2pCropCanvas = null;
        p2pCropCtx = null;
        try { warmedDc?.close(); } catch {}
        try { warmedPc?.close(); } catch {}
        warmedPc = null;
        warmedDc = null;
      });
    })();

    return () => {
      cancelled = true;
      for (const fn of cleanupFns.splice(0)) {
        try { fn(); } catch {}
      }
      setObsTransport((t) => (t === "p2p" ? null : t));
      setObsLatencyMs(null);
    };
  }, [remoteStream, obsEnabled, debugMode]);

  const {
    connectionState,
    error,
    previewStream,
    connect,
    startPreviewLoop,
    disconnect,
    setImage,
    setPrompt,
    applyStudioRequest,
  } = useDecartRealtime();

  useEffect(() => {
    if (studioMode !== "preview") return;
    setRemoteStream(previewStream ?? null);
  }, [studioMode, previewStream]);

  // Pause timer on disconnect: snapshots remaining_ms server-side and releases the lock.
  // Server-side CAS guard ensures only the owner of the lock can release.
  const pauseTimer = useCallback(async (key: string) => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    const ourSession = sessionIdRef.current;
    setSession(null);
    setTimerAnchor(null);
    if (!ourSession) return;
    try {
      await supabase.rpc("pause_studio_session", { p_key: key.trim(), p_session_id: ourSession } as any);
    } catch (e) {
      console.error("Timer pause error:", e);
    }
  }, []);


  const handleEnterStudio = useCallback(() => {
    if (!apiKey.trim()) {
      toast({ title: "Access key required", description: "Paste your assigned access key to enter the studio.", variant: "destructive" });
      return;
    }
    setIsStarted(true);
  }, [apiKey, toast]);

  const handleConnect = useCallback(async () => {
    if (isLaunching) return;
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) {
      toast({ title: "Studio access key required", description: "Your assigned access key is missing. Return to the dashboard and try again.", variant: "destructive" });
      return;
    }

    if (studioMode === "preview") {
      setIsLaunching(true);
      let previewDecartKey = "";
      try {
        try { await disconnect(); } catch { /* noop */ }
        try { localStream?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
        setRemoteStream(null);

        const { data: mint, error: mintErr } = await supabase.rpc(
          "mint_studio_credentials",
          { p_key: trimmedKey } as any,
        );
        if (mintErr) throw new Error(mintErr.message || "Preview session mint failed");
        const row: any = Array.isArray(mint) ? mint[0] : mint;
        if (!row?.ok || !row?.decart_key) {
          throw new Error(row?.reason ? `Preview unavailable: ${row.reason}` : "Could not obtain preview credential");
        }
        previewDecartKey = String(row.decart_key);

        const mintedSessionId: string | null = row.session_id ?? null;
        const mintedRemainingMs: number | null =
          typeof row.remaining_ms === "number" ? row.remaining_ms : null;
        if (mintedSessionId) {
          setSession(mintedSessionId);
          setIsFreeTrial(!!row.is_trial);
          if (mintedRemainingMs != null && mintedRemainingMs > 0) {
            setTimerAnchor({ remainingMs: mintedRemainingMs, perf: performance.now() });
          } else {
            setTimerAnchor(null);
          }
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            frameRate: { ideal: 20, max: 24 },
            width: { ideal: 854 },
            height: { ideal: 480 },
          },
        });
        setLocalStream(stream);
        await startPreviewLoop(previewDecartKey, "Enhance the video slightly", stream);
        setIsStarted(true);
      } catch (e: any) {
        const message = e?.message || "Preview mode could not start";

        // Automatic recovery: if preview backend can't render frames,
        // switch to live realtime with the same minted credential.
        if (previewDecartKey) {
          try {
            try { await disconnect(); } catch { /* noop */ }
            try { localStream?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
            const liveResult = await connect(
              previewDecartKey,
              (transformed) => setRemoteStream(transformed),
              "Enhance the video slightly",
              { lite: liteMode },
            );
            if (liveResult?.stream) setLocalStream(liveResult.stream);
            setIsStarted(true);
            toast({
              title: "Preview backend unavailable",
              description: "Switched to live connection fallback.",
            });
            return;
          } catch {
            // Fall through to normal error path.
          }
        }

        if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
        try {
          await supabase.rpc("pause_studio_session", {
            p_key: trimmedKey,
            p_session_id: sessionIdRef.current,
          } as any);
        } catch { /* noop */ }
        setSession(null);
        setTimerAnchor(null);
        toast({ title: "Preview failed", description: message, variant: "destructive" });
      } finally {
        setIsLaunching(false);
      }
      return;
    }

    // Pre-flight: WebRTC must be available. Inside the Lovable preview iframe,
    // or in privacy-hardened browsers (Brave shields, Firefox media.peerconnection
    // disabled, locked-down Safari), `RTCPeerConnection` is undefined and the
    // Decart SDK throws "RTCPeerConnection is not a constructor".
    if (typeof window !== "undefined" && typeof (window as any).RTCPeerConnection !== "function") {
      const inIframe = window.self !== window.top;
      toast({
        title: "WebRTC is blocked here",
        description: inIframe
          ? "The studio can't run inside this preview frame. Open the app in its own tab (the ↗ icon, or visit your published URL) and try again."
          : "Your browser has WebRTC disabled. Turn off Brave Shields / privacy extensions for this site, or try Chrome, then retry.",
        variant: "destructive",
      });
      return;
    }
    setIsLaunching(true);

    // Pre-clean: if the user just disconnected in this same tab, the browser
    // may still be finishing ICE/DTLS close + camera release. Wait out the
    // remainder of a 1200ms settle window, and defensively re-run teardown
    // in case a stale stream/PeerConnection is still held. Without this the
    // next getUserMedia + WebRTC handshake can stall past the SDK timeout,
    // surfacing as "network took too long to reach the studio".
    const sinceDisconnect = Date.now() - lastDisconnectAtRef.current;
    if (sinceDisconnect < 1200) {
      try { await disconnect(); } catch { /* noop */ }
      try { localStream?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
      await new Promise((r) => setTimeout(r, 1200 - sinceDisconnect));
    }

    // PHASE 1 + 1.5 — single server chokepoint. `mint_studio_credentials`
    // runs the ownership / expiry / trial / active-lock checks, records the
    // Decart connect attempt in Key Activity, and only then hands back the
    // Decart credential for this one connect. The user's studio access key
    // is never sent to Decart directly by the client — the mapping lives
    // server-side in api_key_secrets, which the browser cannot read.
    // Retried once transparently if we hit `already_active_elsewhere` — a
    // previous same-account session usually clears within a few seconds after
    // disconnect in the same tab.
    let decartKey: string = "";
    for (let mintAttempt = 0; mintAttempt < 2; mintAttempt++) {
      try {
        const { data: mint, error: mintErr } = await supabase.rpc(
          "mint_studio_credentials",
          { p_key: trimmedKey } as any,
        );
        if (mintErr) {
          toast({ title: "Studio could not open", description: mintErr.message || "The secure session check failed. Please try again.", variant: "destructive" });
          setIsLaunching(false);
          return;
        }
        const row: any = Array.isArray(mint) ? mint[0] : mint;
        if (!row || !row.ok) {
          if (row?.reason === "already_active_elsewhere") {
            // Auto-retry once after a short wait if this looks like a rapid
            // reconnect (we just disconnected in this tab). Otherwise show
            // the existing "another tab" toast.
            const recentDisconnect = Date.now() - lastDisconnectAtRef.current < 10_000;
            if (mintAttempt === 0 && recentDisconnect) {
              toast({ title: "Finishing your last session…", description: "Reconnecting in a few seconds." });
              await new Promise((r) => setTimeout(r, 2200));
              continue;
            }
            toast({ title: "Session still active", description: "Your account already has a live studio session. Close the other tab, then try again in a few seconds.", variant: "destructive" });
          } else if (row?.reason === "studio_credential_busy") {
            toast({ title: "Studio slot is busy", description: "This studio credential is already connected. Try again in a few seconds, or contact support if it keeps happening.", variant: "destructive" });
          } else if (row?.reason === "trial_time_too_low") {
            setShowTrialEnded(true);
          } else if (row?.reason === "expired_or_inactive") {
            if (row?.is_trial) setShowTrialEnded(true);
            else toast({ title: "API key expired ⏰", description: "Please renew or upgrade to continue.", variant: "destructive" });
          } else if (row?.reason === "not_owner") {
            toast({ title: "This key belongs to another account", description: "Sign in with the account that owns this key, or use one of your own.", variant: "destructive" });
          } else if (row?.reason === "key_not_found") {
            toast({ title: "API key not assigned", description: "This key is not assigned to your account.", variant: "destructive" });
          } else if (row?.reason === "not_authenticated") {
            toast({ title: "Sign in required", description: "Please sign in before opening the studio.", variant: "destructive" });
          } else {
            toast({ title: "Studio could not open", description: "This assigned key could not start a secure studio session.", variant: "destructive" });
          }
          setIsLaunching(false);
          return;
        }
        decartKey = String(row.decart_key || "");
        if (!decartKey) {
          toast({ title: "Studio could not open", description: "Could not obtain a studio credential. Please try again.", variant: "destructive" });
          setIsLaunching(false);
          return;
        }
        // Meter opens at mint (not after connect). Adopt the server-issued
        // session_id and prime the countdown + heartbeat NOW so every second
        // Decart bills during the WebRTC handshake is deducted from the key.
        // If connect() ultimately fails, pause_studio_session snapshots the
        // handshake seconds correctly instead of no-oping.
        const mintedSessionId: string | null = row.session_id ?? null;
        const mintedRemainingMs: number | null =
          typeof row.remaining_ms === "number" ? row.remaining_ms : null;
        if (mintedSessionId) {
          setSession(mintedSessionId);
          setIsFreeTrial(!!row.is_trial);
          if (mintedRemainingMs != null && mintedRemainingMs > 0) {
            setTimerAnchor({ remainingMs: mintedRemainingMs, perf: performance.now() });
          } else {
            setTimerAnchor(null);
          }
          // Heartbeat lifecycle is owned by the top-level effect keyed on
          // sessionIdState — setSession() above triggers it automatically.


        }
        break; // mint OK
      } catch (e) {
        console.error("Mint error:", e);
        toast({ title: "Studio could not open", description: "The secure session check failed. Please try again.", variant: "destructive" });
        setIsLaunching(false);
        return;
      }
    }


    // PHASE 2: Open the Decart connection using the freshly minted credential.
    // Metering already started at mint so handshake time is accounted for.
    let connectResult: Awaited<ReturnType<typeof connect>> | null = null;
    let connectAttempt = 0;

    while (true) {
      try {
        connectResult = await connect(decartKey, (transformed) => {
          setRemoteStream(transformed);
        }, "Enhance the video slightly", { lite: liteMode });
        break;
      } catch (e: any) {
        const raw0 = (e?.message || e?.error?.message || e?.toString?.() || "") + " " + (e?.name || "");
        const isTimeout = /timed out|timeout/i.test(raw0);
        // One silent retry on a first-attempt timeout — rapid reconnects can
        // race the SDK's initial signaling. Fully tear down before retrying.
        if (isTimeout && connectAttempt === 0) {
          connectAttempt++;
          try { await disconnect(); } catch { /* noop */ }
          // Pass the real session id so pause actually snapshots the handshake
          // seconds Decart already burned, instead of no-oping via lock_not_held.
          try { await supabase.rpc("pause_studio_session", { p_key: trimmedKey, p_session_id: sessionIdRef.current } as any); } catch { /* noop */ }
          // Clear locally so the retry mint issues a fresh session id.
          if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
          setSession(null);
          setTimerAnchor(null);
          await new Promise((r) => setTimeout(r, 1000));
          // Re-mint on retry: the previous session_id is now closed and the
          // key needs a fresh lock + session row.
          try {
            const { data: reMint } = await supabase.rpc("mint_studio_credentials", { p_key: trimmedKey } as any);
            const rrow: any = Array.isArray(reMint) ? reMint[0] : reMint;
            if (rrow?.ok && rrow.decart_key) {
              decartKey = String(rrow.decart_key);
              if (rrow.session_id) {
                setSession(rrow.session_id);
                const rMs = typeof rrow.remaining_ms === "number" ? rrow.remaining_ms : null;
                if (rMs != null && rMs > 0) setTimerAnchor({ remainingMs: rMs, perf: performance.now() });
                // Heartbeat lifecycle owned by top-level effect on sessionIdState.


              }
            }
          } catch { /* noop */ }
          continue;
        }
        // Non-retryable error — run the full mapping and bail.
        {
      const raw = e?.message || e?.error?.message || e?.toString?.() || "";
      const name: string = e?.name || e?.error?.name || "";
      console.error("[Studio] Decart connect failed:", e, "raw:", raw, "name:", name);
      const lower = (raw + " " + name).toLowerCase();
      const isCapacity =
        lower.includes("quota") ||
        lower.includes("credit") ||
        lower.includes("limit") ||
        lower.includes("balance") ||
        lower.includes("exhaust");

      // Release the session lock and snapshot any handshake seconds Decart
      // already billed — pass the real session id so pause charges wall-clock.
      if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
      try { await supabase.rpc("pause_studio_session", { p_key: trimmedKey, p_session_id: sessionIdRef.current } as any); } catch { /* noop */ }
      setSession(null);
      setTimerAnchor(null);

      if (isCapacity) {
        toast({
          title: "Studio is briefly at capacity",
          description:
            "Our processing provider is topping up capacity right now. Please try again in a few minutes. If it keeps happening, contact support.",
        });
        setIsLaunching(false);
        return;
      }

      let title = "Connection failed";
      let description = "Studio couldn't start right now. Please try again in a moment.";
      const fallbackHint = lower.includes("preserve reference face identity") ? "" : "";

      if (name === "OverconstrainedError" || lower.includes("overconstrained")) {
        title = "Camera doesn't support this resolution";
        description = "Toggle Lite mode from the header and try again. If it persists, try a different camera.";
      } else if (name === "NotReadableError" || lower.includes("notreadable") || lower.includes("could not start video source")) {
        description = "Your camera is in use by another app (Zoom, Teams, OBS, Meet…). Close it and retry.";
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError" || lower.includes("requested device not found")) {
        description = "No camera detected. Plug one in or enable camera access, then retry.";
      } else if (name === "NotAllowedError" || lower.includes("permission") || lower.includes("notallowed") || lower.includes("getusermedia")) {
        description = "Camera/microphone permission was blocked. Allow access in your browser and try again.";
      } else if (lower.includes("timed out") || lower.includes("timeout")) {
        title = "Connection timed out";
        description = "Your network took too long to reach the studio. Try again, or switch off VPN / restrictive Wi‑Fi.";
      } else if (lower.includes("401") || lower.includes("unauthor") || (lower.includes("invalid") && lower.includes("key"))) {
        description = "Your API key was rejected. Please confirm it's the exact key shown in your dashboard.";
      } else if (lower.includes("network") || lower.includes("failed to fetch") || lower.includes("ice") || lower.includes("dtls")) {
        description = "Your network is blocking realtime video (firewall / VPN / restrictive Wi‑Fi). Try a different network.";
      } else if (lower.includes("prompt") || lower.includes("content")) {
        description = "The current prompt could not be applied safely. Please try a simpler prompt or reconnect the studio.";
      }

      toast({ title, description, variant: "destructive" });
      setIsLaunching(false);
      return;
        }
      }
    }

    if (connectResult?.stream) {
      setLocalStream(connectResult.stream);
      // Adaptive capture fallback: if the browser can't sustain ≥18 fps for
      // 5s, downgrade constraints once (drops resolution, keeps fps target).
      // Only triggers on non-lite; lite is already at the floor.
      if (!liteMode) {
        const vTrack = connectResult.stream.getVideoTracks()[0];
        const vEl = document.createElement("video");
        vEl.muted = true; vEl.playsInline = true; vEl.srcObject = connectResult.stream;
        vEl.play().catch(() => {});
        const anyEl = vEl as any;
        if (vTrack && typeof anyEl.requestVideoFrameCallback === "function") {
          let frames = 0;
          const start = performance.now();
          const cb = () => { frames++; anyEl.requestVideoFrameCallback(cb); };
          anyEl.requestVideoFrameCallback(cb);
          setTimeout(async () => {
            const elapsed = (performance.now() - start) / 1000;
            const fps = frames / Math.max(elapsed, 0.001);
            if (fps < 18) {
              try {
                // Lucy 2.5 native tick is 20 fps — asking for 24 ideal
                // just wastes capture cycles the encoder then drops.
                // Drop resolution only; keep fps aligned to the model.
                await vTrack.applyConstraints({
                  frameRate: { ideal: 20, max: 24 },
                  width: { ideal: 512, max: 640 },
                  height: { ideal: 296, max: 368 },
                });
                console.info("[Studio] capture auto-downgraded for stability", { measuredFps: fps.toFixed(1) });
              } catch (e) {
                console.warn("[Studio] applyConstraints downgrade failed", e);
              }
            }
          }, 5000);
        }
      }
    }
    setIsStarted(true);
    // Track studio connect — fire-and-forget so it never blocks UI
    void supabase.auth.getUser().then(({ data }) => {
      if (!data.user) return;
      void supabase.from("user_activity_logs").insert([{
        user_id: data.user.id,
        action: "studio_connect",
        page: "/studio",
        metadata: {} as any,
      }]).then(() => {}, () => {});
    });
    setIsLaunching(false);
  }, [apiKey, connect, disconnect, error, toast, liteMode, isLaunching, studioMode, applyStudioRequest, localStream, startPreviewLoop]);

  useEffect(() => {
    if (!autoStartPending || isStarted || !apiKey.trim()) return;
    setAutoStartPending(false);
    void handleConnect();
  }, [apiKey, autoStartPending, handleConnect, isStarted]);

  const handleDisconnect = useCallback(async () => {
    // Track studio disconnect — fire-and-forget
    void supabase.auth.getUser().then(({ data }) => {
      if (!data.user) return;
      void supabase.from("user_activity_logs").insert([{
        user_id: data.user.id,
        action: "studio_disconnect",
        page: "/studio",
        metadata: {} as any,
      }]).then(() => {}, () => {});
    });
    // Pause the countdown timer before disconnecting
    await pauseTimer(apiKey);
    // Tear down the SDK first (closes PeerConnection), THEN stop camera/mic
    // tracks. Doing tracks-first can leave the PC trying to send on a dead
    // sender, which prolongs the ICE close and slows the next reconnect.
    try { await disconnect(); } catch { /* noop */ }
    try { localStream?.getTracks().forEach(t => t.stop()); } catch { /* noop */ }
    setLocalStream(null);
    setRemoteStream(null);
    // Small settle window so ICE/DTLS close + camera release finish before
    // the user's next click. 600ms is generous for desktop, unnoticeable for UX.
    await new Promise((r) => setTimeout(r, 600));
    lastDisconnectAtRef.current = Date.now();
    setIsStarted(false);
  }, [disconnect, localStream, pauseTimer, apiKey]);

  // Keep ref in sync so the countdown effect can call the latest version
  useEffect(() => {
    handleDisconnectRef.current = handleDisconnect;
  }, [handleDisconnect]);

  // Tab-close / navigate-away safety net.
  // Decart bills wall-clock as long as the WebRTC session is alive on their
  // side. If the user closes the tab without clicking Disconnect, our normal
  // pauseTimer path is aborted by the browser. pagehide (below) covers a
  // clean close/navigate immediately. A true crash (power loss, force-kill,
  // OS crash — no pagehide fires) instead falls to the server-side reaper,
  // which closes the session once `hard_stale_ms` (studio_pricing_config,
  // 90s by default as of the 2026-07-16 tuning pass — check the live value
  // in the admin Pricing panel, not just this comment) has elapsed since the
  // last heartbeat. That's up to `hard_stale_ms` of unbilled-to-user burn
  // per crash, not 15-20s — size expectations off the config, not this note.
  // We use fetch(..., { keepalive: true }) to fire pause_studio_session
  // synchronously at pagehide/visibilitychange-hidden — keepalive fetches
  // are allowed to complete after the document is gone.
  useEffect(() => {
    const readJwt = (): { anon: string; jwt: string } | null => {
      try {
        const anon = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
        let jwt = anon;
        const raw = Object.keys(localStorage).find(k => k.startsWith("sb-") && k.endsWith("-auth-token"));
        if (raw) {
          const parsed = JSON.parse(localStorage.getItem(raw) || "{}");
          if (parsed?.access_token) jwt = parsed.access_token;
        }
        return { anon, jwt };
      } catch { return null; }
    };
    const firePauseBeacon = () => {
      const sid = sessionIdRef.current;
      const key = apiKeyRef.current?.trim();
      if (!sid || !key) return;
      const creds = readJwt();
      if (!creds) return;
      try {
        void fetch(`${import.meta.env.VITE_SUPABASE_URL}/rest/v1/rpc/pause_studio_session`, {
          method: "POST",
          keepalive: true,
          headers: { "content-type": "application/json", apikey: creds.anon, authorization: `Bearer ${creds.jwt}` },
          body: JSON.stringify({ p_key: key, p_session_id: sid }),
        }).catch(() => {});
        setSession(null);
      } catch { /* noop */ }
    };
    // On tab hidden (mobile app-switch, permission prompt, PiP), we USED to pause —
    // that killed legitimate sessions and left Decart burning. Instead, fire a
    // keepalive heartbeat so the server-side reaper's poll-and-debit keeps the
    // ledger correct without terminating the live WebRTC connection.
    const fireHeartbeatBeacon = () => {
      const sid = sessionIdRef.current;
      const key = apiKeyRef.current?.trim();
      if (!sid || !key) return;
      const creds = readJwt();
      if (!creds) return;
      try {
        void fetch(`${import.meta.env.VITE_SUPABASE_URL}/rest/v1/rpc/heartbeat_studio_session`, {
          method: "POST",
          keepalive: true,
          headers: { "content-type": "application/json", apikey: creds.anon, authorization: `Bearer ${creds.jwt}` },
          body: JSON.stringify({ p_key: key, p_session_id: sid }),
        }).catch(() => {});
      } catch { /* noop */ }
    };
    // pagehide = user is actually leaving the document (close/navigate). Pause.
    const onPageHide = () => firePauseBeacon();
    // visibilitychange hidden = tab backgrounded. Send heartbeat, keep session live.
    const onVisibility = () => {
      if (document.visibilityState === "hidden") fireHeartbeatBeacon();
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);



  // Merge optional hair/outfit hints into a prompt. The identity-lock suffix
  // is added later inside useDecartRealtime — this only inserts user-supplied
  // reinforcement so the model has explicit textual context.
  const buildPrompt = useCallback((base: string): string => {
    const parts: string[] = [base.trim()];
    const hair = hairHint.trim();
    const outfit = outfitHint.trim();
    if (hair) parts.push(`hairstyle: ${hair}`);
    if (outfit) parts.push(`outfit: ${outfit}`);
    const combined = parts.filter(Boolean).join(". ");
    return buildPromptWithIdentityGuard(combined);
  }, [hairHint, outfitHint]);

  const handlePresetSelect = useCallback(async (prompt: string) => {
    const composed = buildPrompt(prompt);
    const result = await applyStudioRequest({
      prompt: composed,
      image: referenceImage,
      enhance: true,
      mode: studioMode,
    });

    if (result.success) {
      console.info("[studio] studio request ok", result.metadata);
    } else {
      console.warn("[studio] studio request fallback", result.error);
    }

    toast({ title: "Character updated! ✨", description: referenceImage ? "Face swap applied — your motion drives the reference image." : "Transformation is being applied..." });
  }, [applyStudioRequest, referenceImage, toast, buildPrompt, studioMode]);

  const handleCustomPrompt = useCallback(async () => {
    if (!customPrompt.trim()) return;
    const composed = buildPrompt(customPrompt);
    const result = await applyStudioRequest({
      prompt: composed,
      image: referenceImage,
      enhance: true,
      mode: studioMode,
    });

    if (result.success) {
      console.info("[studio] prompt request ok", result.metadata);
    } else {
      console.warn("[studio] prompt request fallback", result.error);
    }

    toast({ title: "Prompt applied! 🎨" });
  }, [applyStudioRequest, customPrompt, referenceImage, toast, buildPrompt, studioMode]);

  const handleImageUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const picked = input.files?.[0];
    if (!picked) return;
    // Always clear the input value so the same file can be re-picked after a block.
    input.value = "";

    let file = picked;
    if (REFERENCE_GATE_ENABLED) {
      try {
        const score = await scoreImage(picked);
        if (score.tier === "blocked") {
          setBlockedReason(score.reason ?? "This photo can't be used.");
          return;
        }
        // Enhance every accepted upload (pass + marginal). The wider crop now
        // includes shoulders/torso so Lucy has outfit context to preserve.
        try {
          file = await enhanceImage(picked, score);
          if (score.tier === "marginal") {
            toast({
              title: "Photo optimized ✨",
              description: "We enhanced your reference for a cleaner swap.",
            });
          }
        } catch {
          // Fall through with the original file — enhancement is best-effort.
          file = picked;
        }
      } catch {
        // Scoring failure shouldn't block upload — proceed with original file.
        file = picked;
      }
    }

    setReferenceImage(file);
    appliedReferenceRef.current = null;
    const url = URL.createObjectURL(file);
    setReferencePreview(url);

    const applyPrompt = buildPrompt("Apply this face to the person, preserving their motion and expressions");
    if (connectionState === "connected" || connectionState === "generating") {
      await applyStudioRequest({
        prompt: applyPrompt,
        image: file,
        enhance: true,
        mode: studioMode,
      });
      appliedReferenceRef.current = file;
      toast({ title: "Face swap active! 🎭", description: "Your webcam motion now drives the reference face in realtime." });
    } else {
      toast({ title: "Reference ready 📸", description: "It will apply automatically as soon as you connect." });
    }
  }, [toast, connectionState, setImage, buildPrompt]);

  const handleClearImage = useCallback(async () => {
    setReferenceImage(null);
    appliedReferenceRef.current = null;
    if (referencePreview) URL.revokeObjectURL(referencePreview);
    setReferencePreview(null);
    await applyStudioRequest({
      prompt: "Enhance the video slightly",
      image: null,
      enhance: true,
      mode: studioMode,
    });
    toast({ title: "Reference cleared", description: "Switched back to prompt-only mode." });
  }, [applyStudioRequest, referencePreview, toast, studioMode]);


  const isConnected =
    connectionState === "connected" ||
    connectionState === "generating" ||
    connectionState === "preview_loop";

  // Auto-apply a pre-picked reference image the moment the session goes live.
  useEffect(() => {
    if (!isConnected) return;
    const file = referenceImage;
    if (!file) return;
    if (appliedReferenceRef.current === file) return;
    appliedReferenceRef.current = file;
    (async () => {
      try {
        await applyStudioRequest({
          prompt: buildPrompt("Apply this face to the person, preserving their motion and expressions"),
          image: file,
          enhance: true,
          mode: studioMode,
        });
        toast({ title: "Face swap active! 🎭", description: "Your webcam motion now drives the reference face in realtime." });
      } catch (err) {
        console.warn("[studio] auto-apply reference failed", err);
        appliedReferenceRef.current = null;
      }
    })();
  }, [applyStudioRequest, isConnected, referenceImage, toast, buildPrompt, studioMode]);


  // Keep connection state in diagnostics HUD when ?debug=1
  useEffect(() => {
    if (debugMode) setDiagnostics((d) => ({ ...d, connectionState }));
  }, [connectionState, debugMode]);

  const obsUrl = `${window.location.origin}/obs-output?key=${encodeURIComponent(apiKey)}`;

  // Auto-enable the broadcast effect — many users copy the URL into OBS
  // without realizing they also need to flip the toggle on. Persists per-key.
  const ensureObsEnabled = useCallback(() => {
    if (!obsEnabled) {
      setObsEnabled(true);
      try {
        if (apiKey) localStorage.setItem(`obs-enabled-${apiKey}`, "1");
      } catch {}
    }
  }, [obsEnabled, apiKey]);

  const copyObsUrl = () => {
    navigator.clipboard.writeText(obsUrl);
    ensureObsEnabled();
    toast({ title: "OBS URL copied! 📋", description: "Paste this as a Browser Source in OBS Studio. Broadcast is now ON." });
  };

  if (!isStarted) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="w-full max-w-md space-y-8 text-center">
          <div className="space-y-3">
            <h1 className="text-5xl font-heading font-bold gradient-text">Elite Swap</h1>
            <p className="text-muted-foreground font-body">
              Enter the studio first — you'll connect to Elite Swap when you're ready.
            </p>
          </div>

          <div className="glass neon-border rounded-2xl p-6 space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-heading text-foreground/70 block text-left">
                Studio Access Key {apiKey ? <span className="text-primary">✓ ready</span> : <span className="text-destructive">required</span>}
              </label>
              <Input
                type="password"
                placeholder="Your assigned access key..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="bg-muted/30 border-border focus:border-primary"
                onKeyDown={(e) => e.key === "Enter" && handleEnterStudio()}
              />
              <p className="text-xs text-muted-foreground/60 text-left">Paste the access key assigned to your account.</p>
            </div>
            <Button
              onClick={handleEnterStudio}
              className="w-full bg-primary text-primary-foreground hover:bg-primary/90 font-heading font-semibold neon-glow"
            >
              Enter Studio →
            </Button>
          </div>

          <p className="text-xs text-muted-foreground/50">
            Your key stays in your browser. Nothing is stored.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      {showPayment && <CryptoPayment onClose={() => setShowPayment(false)} />}
      {debugMode && (
        <StudioDiagnostics
          localStream={localStream}
          remoteStream={remoteStream}
          state={diagnostics}
        />
      )}
      <ReviewPromptModal
        open={showReviewPrompt}
        onClose={() => setShowReviewPrompt(false)}
        onDismissForever={() => {
          if (user) localStorage.setItem(`review-prompt-dismissed-${user.id}`, "1");
        }}
      />
      <ReferenceBlockedDialog
        open={blockedReason !== null}
        reason={blockedReason ?? ""}
        onChooseAnother={() => {
          setBlockedReason(null);
          fileInputRef.current?.click();
        }}
        onCancel={() => setBlockedReason(null)}
      />
      {showTrialEnded && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
          <div className="glass neon-border rounded-2xl p-6 max-w-sm w-full text-center space-y-4">
            <div className="text-4xl">⏰</div>
            <h2 className="text-xl font-heading font-bold text-foreground">Free trial ended</h2>
            <p className="text-sm text-muted-foreground">
              Hope you liked it! Upgrade to keep using Elite Swap with no time limit and no watermark.
            </p>
            <div className="flex flex-col gap-2">
              <Button
                onClick={() => { window.location.href = "/dashboard"; }}
                className="w-full bg-primary text-primary-foreground hover:bg-primary/90 font-heading neon-glow"
              >
                Upgrade Now 💎
              </Button>
              <Button
                onClick={() => setShowTrialEnded(false)}
                variant="ghost"
                size="sm"
                className="font-heading text-xs"
              >
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
      {/* Header */}
      <header className="border-b border-border glass px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-heading font-bold gradient-text">Elite Swap</h1>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className={`w-2 h-2 rounded-full ${
              connectionState === "generating" ? "bg-neon-green animate-pulse-neon" :
              isConnected ? "bg-primary" :
              connectionState === "connecting" || connectionState === "reconnecting" ? "bg-amber-400 animate-pulse-neon" :
              "bg-destructive"
            }`} />
            <span className="font-heading uppercase tracking-wider">{connectionState}</span>
          </div>
          {referenceImage && (
            <span className="text-xs bg-primary/20 text-primary px-2 py-0.5 rounded-full font-heading">
              🎭 Face Swap Active
            </span>
          )}
          <StudioCountdown anchor={timerAnchor} onExpire={handleExpire} />
        </div>
        <div className="flex items-center gap-2">
          {/* Orientation toggle */}
          <div className="flex items-center border border-border rounded-lg overflow-hidden">
            <button
              onClick={() => setOrientation("landscape")}
              className={`p-1.5 transition-colors ${orientation === "landscape" ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground"}`}
              title="Landscape (16:9)"
            >
              <Monitor className="w-4 h-4" />
            </button>
            <button
              onClick={() => setOrientation("portrait")}
              className={`p-1.5 transition-colors ${orientation === "portrait" ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground"}`}
              title="Portrait (9:16)"
            >
              <Smartphone className="w-4 h-4" />
            </button>
          </div>
          {/* Lite mode toggle — auto-on for weak hardware */}
          <button
            onClick={toggleLiteMode}
            className={`flex items-center gap-1 px-2 py-1 rounded-lg border text-xs font-heading transition-colors ${
              liteMode
                ? "border-primary/40 bg-primary/15 text-primary"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
            title={liteMode ? "Lite mode ON — slightly lower resolution for stability, full frame rate preserved for lip sync. Turn off if your lip sync looks soft." : "Lite mode OFF — full resolution and frame rate"}
            aria-pressed={liteMode}
          >
            <Zap className="w-3.5 h-3.5" />
            Lite
          </button>
          <Button
            onClick={() => setShowPayment(true)}
            size="sm"
            className="bg-gradient-to-r from-amber-500 to-yellow-500 text-primary-foreground hover:from-amber-600 hover:to-yellow-600 font-heading text-xs"
          >
            💰 Pay
          </Button>
          {!isConnected && connectionState !== "connecting" && connectionState !== "reconnecting" ? (
            <Button
              onClick={handleConnect}
              disabled={isLaunching}
              size="sm"
              className="bg-primary text-primary-foreground hover:bg-primary/90 font-heading text-xs neon-glow"
            >
              {isLaunching ? "Connecting…" : "Connect 🚀"}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={handleDisconnect}
              className="border-destructive/30 text-destructive hover:bg-destructive/10 font-heading text-xs"
            >
              Disconnect
            </Button>
          )}
        </div>
      </header>

      {/* Main content */}
      <div className="flex-1 flex flex-col lg:flex-row gap-4 p-4">
        {/* Video feeds */}
        <div
          className={`flex-1 relative ${outputExpanded ? "" : "grid grid-cols-1 md:grid-cols-2 gap-4"}`}
          style={{ contain: "layout paint" }}
        >
          <VideoDisplay
            stream={localStream}
            label="Your Camera (Motion Source)"
            mirrored
            isMinimized={outputExpanded}
            paused={outputExpanded}
            onToggleExpand={() => setOutputExpanded(false)}
            orientation={orientation}
          />
          <div className="relative">
            <VideoDisplay
              stream={remoteStream}
              label="Face Swap Output"
              isOutput
              isExpanded={outputExpanded}
              onToggleExpand={() => setOutputExpanded(!outputExpanded)}
              orientation={orientation}
            />
            {isFreeTrial && (
              <div className="pointer-events-none absolute bottom-3 right-3 px-3 py-1.5 rounded-md bg-background/70 backdrop-blur-sm border border-primary/40 z-10">
                <div className="text-[10px] font-heading font-bold text-primary leading-tight">ELITE SWAP</div>
                <div className="text-[9px] text-muted-foreground leading-tight">eliteswap.online · Free Trial</div>
              </div>
            )}
          </div>
        </div>

        {/* Controls sidebar */}
        <div className="w-full lg:w-80 space-y-4" style={{ contain: "layout paint" }}>
          {/* Reference Image */}
          <div className="glass neon-border rounded-xl p-4 space-y-3">
            <h2 className="font-heading font-semibold text-sm text-foreground/80 uppercase tracking-wider">
              Reference Face
            </h2>
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                Upload a face image — your webcam motion will drive it in realtime.
              </p>
              <PhotoTipsPopover />
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleImageUpload}
              className="hidden"
            />
            {referencePreview ? (
              <div className="relative group">
                <img src={referencePreview} alt="Reference" className="w-full aspect-square object-cover rounded-lg border border-primary/30" />
                <div className="absolute inset-0 bg-primary/5 rounded-lg flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={handleClearImage}
                    className="px-3 py-1.5 rounded-lg bg-destructive/90 text-destructive-foreground text-xs font-heading font-semibold"
                  >
                    Remove
                  </button>
                </div>
                <div className="absolute top-2 left-2 px-2 py-0.5 rounded bg-primary/80 text-primary-foreground text-xs font-heading">
                  Active
                </div>
              </div>
            ) : (
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full aspect-video rounded-lg border-2 border-dashed border-border hover:border-primary/40 transition-colors flex flex-col items-center justify-center gap-2 text-muted-foreground"
              >

                <span className="text-3xl">🎭</span>
                <span className="text-xs font-heading">Upload a face to swap into</span>
                <span className="text-xs text-muted-foreground/50">Your motion will drive this face</span>
              </button>
            )}
          </div>

          {/* Character Presets */}
          <div className="glass neon-border rounded-xl p-4 space-y-3">
            <h2 className="font-heading font-semibold text-sm text-foreground/80 uppercase tracking-wider">
              Style Presets
            </h2>
            <CharacterPresets onSelect={handlePresetSelect} disabled={!isConnected} />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border/60 bg-background/60 p-2">
            <span className="text-xs font-medium text-muted-foreground">Studio execution</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setStudioMode("preview")}
                className={`rounded-full px-3 py-1 text-xs transition ${studioMode === "preview" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
              >
                Preview
              </button>
              <button
                type="button"
                onClick={() => setStudioMode("live")}
                className={`rounded-full px-3 py-1 text-xs transition ${studioMode === "live" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
              >
                Live
              </button>
            </div>
          </div>

          {/* Custom Prompt */}
          <div className="glass neon-border rounded-xl p-4 space-y-3">
            <h2 className="font-heading font-semibold text-sm text-foreground/80 uppercase tracking-wider">
              Custom Prompt
            </h2>
            <div className="flex gap-2">
              <Input
                placeholder="Describe a transformation..."
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCustomPrompt()}
                disabled={!isConnected}
                className="bg-muted/30 border-border focus:border-primary text-sm"
              />
              <Button
                onClick={handleCustomPrompt}
                disabled={!isConnected || !customPrompt.trim()}
                size="sm"
                className="bg-primary text-primary-foreground hover:bg-primary/90 shrink-0"
              >
                Go
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-2 pt-1">
              <Input
                placeholder='Hair (e.g. "short black bob")'
                value={hairHint}
                onChange={(e) => setHairHint(e.target.value)}
                className="bg-muted/30 border-border focus:border-primary text-xs"
              />
              <Input
                placeholder='Outfit (e.g. "red blazer")'
                value={outfitHint}
                onChange={(e) => setOutfitHint(e.target.value)}
                className="bg-muted/30 border-border focus:border-primary text-xs"
              />
            </div>
            <p className="text-[10px] text-muted-foreground leading-snug">
              Optional. Reinforces the reference image's hair &amp; outfit. Applied on the next prompt or preset change.
            </p>
          </div>

          {/* OBS Integration */}
          <div className="glass neon-border rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-heading font-semibold text-sm text-foreground/80 uppercase tracking-wider">
                OBS Studio Integration
              </h2>
              <div className="flex items-center gap-2">
                {obsEnabled && (
                  <span
                    className={`flex items-center gap-1 text-[10px] font-heading uppercase tracking-wider ${
                      obsViewerCount > 0 ? "text-neon-green" : "text-muted-foreground"
                    }`}
                    title={obsViewerCount > 0 ? "OBS is connected and receiving frames" : "Waiting for OBS to connect"}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${obsViewerCount > 0 ? "bg-neon-green animate-pulse-neon" : "bg-muted-foreground"}`} />
                    {obsViewerCount > 0 ? `Live (${obsViewerCount})` : "Idle"}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => {
                    const next = !obsEnabled;
                    setObsEnabled(next);
                    try {
                      if (apiKey) localStorage.setItem(`obs-enabled-${apiKey}`, next ? "1" : "0");
                    } catch {}
                  }}
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${obsEnabled ? "bg-primary" : "bg-muted"}`}
                  title={obsEnabled ? "Disable OBS output" : "Enable OBS output"}
                  aria-pressed={obsEnabled}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-background transition-transform ${obsEnabled ? "translate-x-4" : "translate-x-0.5"}`}
                  />
                </button>
              </div>
            </div>
            {/* Live broadcast telemetry — transport, codec, latency, bitrate */}
            {obsEnabled && obsViewerCount > 0 && (obsCodec || obsTransport) && (
              <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground flex-wrap">
                {obsTransport && (
                  <span className={`px-1.5 py-0.5 rounded ${obsTransport === "p2p" ? "bg-neon-cyan/15 text-neon-cyan" : "bg-muted text-muted-foreground"}`}>
                    {obsTransport === "p2p" ? "P2P · DataChannel" : "Broker · Realtime"}
                  </span>
                )}
                {obsCodec && (
                  <span className={`px-1.5 py-0.5 rounded ${obsCodec === "h264" ? "bg-neon-green/15 text-neon-green" : "bg-muted text-muted-foreground"}`}>
                    {obsCodec === "h264" ? "H.264 HW" : "JPEG"}
                  </span>
                )}
                {obsLatencyMs !== null && <span>{obsLatencyMs} ms glass-to-glass</span>}
                {obsLatencyMs === null && obsEncodeMs !== null && <span>{obsEncodeMs} ms encode</span>}
                {obsBitrateKbps !== null && <span>· {obsBitrateKbps} kbps</span>}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {obsEnabled
                ? "Drag the link below into OBS, or copy/download it as a Browser Source. The status indicator above turns green when OBS connects."
                : "Off to save CPU. Toggle on (or just copy the link) to start broadcasting."}
            </p>
            <a
              href={obsUrl}
              draggable="true"
              onDragStart={(e) => {
                e.dataTransfer.setData("text/uri-list", obsUrl);
                e.dataTransfer.setData("text/plain", obsUrl);
                ensureObsEnabled();
              }}
              onClick={(e) => { e.preventDefault(); copyObsUrl(); }}
              className="w-full flex items-center gap-2 bg-muted/30 border border-border rounded-lg px-3 py-2 text-[10px] font-mono text-foreground/70 break-all cursor-grab hover:border-primary/40 active:cursor-grabbing transition-colors"
              title="Drag into OBS or click to copy"
            >
              <GripVertical className="w-3 h-3 shrink-0 text-muted-foreground" />
              <span className="flex-1">{obsUrl}</span>
            </a>
            <div className="grid grid-cols-2 gap-2">
              <Button onClick={copyObsUrl} size="sm" variant="outline" className="font-heading text-xs">
                <Copy className="w-3 h-3 mr-1.5" />
                Copy URL
              </Button>
              <Button
                onClick={() => {
                  const blob = new Blob([`[InternetShortcut]\nURL=${obsUrl}\n`], { type: "application/internet-shortcut" });
                  const a = document.createElement("a");
                  a.href = URL.createObjectURL(blob);
                  a.download = "EliteSwap-OBS.url";
                  a.click();
                  URL.revokeObjectURL(a.href);
                  ensureObsEnabled();
                  toast({ title: "Shortcut downloaded! 📁", description: "Double-click the file or drag it into OBS. Broadcast is now ON." });
                }}
                size="sm"
                variant="outline"
                className="font-heading text-xs"
              >
                <Download className="w-3 h-3 mr-1.5" />
                Download .url
              </Button>
            </div>
          </div>

          {/* Error display */}
          {error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3">
              <p className="text-xs text-destructive">{error}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
