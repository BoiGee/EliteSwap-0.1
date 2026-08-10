import { useRef, useState, useCallback, useEffect } from "react";
import { createDecartClient, models } from "@decartai/sdk";
import type { SetInput } from "@decartai/sdk";
import { buildPromptWithIdentityGuard } from "@/lib/lucyPromptGuard";
import { DecartStudioEngine } from "@/lib/decartStudioEngine";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "generating" | "reconnecting" | "preview_loop";

const UPDATE_DEBOUNCE_MS = 300;
const PREVIEW_LOOP_INTERVAL_MS = 2000; // Submit preview every 2 seconds as fallback

// Back-compat alias so existing call sites keep working.
const withIdentityLock = buildPromptWithIdentityGuard;

export function useDecartRealtime() {
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [previewOutputUrl, setPreviewOutputUrl] = useState<string | null>(null);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [previewResult, setPreviewResult] = useState<any>(null);
  const realtimeClientRef = useRef<any>(null);
  const clientRef = useRef<any>(null);
  const stopAnimationRef = useRef<(() => void) | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingUpdateRef = useRef<(() => Promise<void>) | null>(null);
  
  // Preview loop refs
  const previewLoopIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const previewEngineRef = useRef<any>(null);
  const previewApiKeyRef = useRef<string>("");
  // Guards every real Decart preview submit (loop ticks AND ad-hoc
  // applyStudioRequest calls) so at most one is ever in flight. Without this,
  // a slow/hung response (up to the 15s submit timeout) let the 2s tick
  // interval stack multiple concurrent — and separately billed — Decart
  // requests on top of each other.
  const previewBusyRef = useRef(false);
  const previewInputVideoRef = useRef<HTMLVideoElement | null>(null);
  const previewInputCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const previewStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    previewStreamRef.current = previewStream;
  }, [previewStream]);

  const ensurePreviewSurface = useCallback(() => {
    if (!previewCanvasRef.current) {
      const canvas = document.createElement("canvas");
      canvas.width = 854;
      canvas.height = 480;
      previewCanvasRef.current = canvas;
      previewCtxRef.current = canvas.getContext("2d");
      const stream = canvas.captureStream(10);
      setPreviewStream(stream);
    }
    return {
      canvas: previewCanvasRef.current,
      ctx: previewCtxRef.current,
    };
  }, []);

  const drawPreviewFromUrl = useCallback(async (url: string) => {
    const { canvas, ctx } = ensurePreviewSurface();
    if (!canvas || !ctx) return;
    const loadImage = (src: string) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Failed to load preview frame"));
        img.src = src;
      });

    let img: HTMLImageElement;
    try {
      img = await loadImage(url);
    } catch (directErr) {
      // Some preview URLs are protected and require bearer auth.
      if (!/^https?:\/\//i.test(url) || !previewApiKeyRef.current) throw directErr;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${previewApiKeyRef.current}` },
      });
      if (!res.ok) throw new Error(`Preview frame fetch failed with ${res.status}`);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      try {
        img = await loadImage(blobUrl);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    }

    const cw = canvas.width;
    const ch = canvas.height;
    const iw = img.naturalWidth || img.width || cw;
    const ih = img.naturalHeight || img.height || ch;
    const scale = Math.min(cw / iw, ch / ih);
    const dw = Math.round(iw * scale);
    const dh = Math.round(ih * scale);
    const dx = Math.round((cw - dw) / 2);
    const dy = Math.round((ch - dh) / 2);
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = "#0b0b0b";
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(img, dx, dy, dw, dh);
  }, [ensurePreviewSurface]);

  const isOfflineFallback = useCallback((result: any): boolean => {
    if (!result || typeof result !== "object") return false;
    if ((result as any).metadata?.offline_fallback === true) return true;
    if ((result as any).data?.fallback === "offline_credit_safe") return true;
    return false;
  }, []);

  const ensurePreviewInputVideo = useCallback((sourceStream?: MediaStream | null) => {
    if (!sourceStream) return null;
    if (!previewInputVideoRef.current) {
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      video.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";
      document.body.appendChild(video);
      previewInputVideoRef.current = video;
    }
    if (previewInputVideoRef.current.srcObject !== sourceStream) {
      previewInputVideoRef.current.srcObject = sourceStream;
    }
    void previewInputVideoRef.current.play().catch(() => {});
    if (!previewInputCanvasRef.current) {
      previewInputCanvasRef.current = document.createElement("canvas");
    }
    return previewInputVideoRef.current;
  }, []);

  const capturePreviewInputImage = useCallback(async (sourceStream?: MediaStream | null): Promise<string | null> => {
    const video = ensurePreviewInputVideo(sourceStream);
    const canvas = previewInputCanvasRef.current;
    if (!video || !canvas) return null;
    if (!video.videoWidth || !video.videoHeight) {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    const targetW = 640;
    const targetH = Math.max(360, Math.round((targetW * vh) / vw));
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, targetW, targetH);
    return canvas.toDataURL("image/jpeg", 0.72);
  }, [ensurePreviewInputVideo]);

  const drawPreviewStatus = useCallback((message: string) => {
    const { canvas, ctx } = ensurePreviewSurface();
    if (!canvas || !ctx) return;
    const cw = canvas.width;
    const ch = canvas.height;
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = "#0b0b0b";
    ctx.fillRect(0, 0, cw, ch);
    ctx.fillStyle = "#7ef9a9";
    ctx.font = "600 26px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Preview", cw / 2, ch / 2 - 10);
    ctx.fillStyle = "#c7c7c7";
    ctx.font = "400 16px system-ui, sans-serif";
    ctx.fillText(message, cw / 2, ch / 2 + 22);
  }, [ensurePreviewSurface]);

  const pickPreviewUrl = useCallback((result: any): string | null => {
    if (!result || typeof result !== "object") return null;
    if (typeof result.outputUrl === "string" && result.outputUrl.trim()) return result.outputUrl;
    const data = result.data && typeof result.data === "object" ? result.data : null;
    if (data) {
      const outputUrl = (data as any).output_url;
      if (typeof outputUrl === "string" && outputUrl.trim()) return outputUrl;
      const url = (data as any).url;
      if (typeof url === "string" && url.trim()) return url;
      const resultNode = (data as any).result;
      if (resultNode && typeof resultNode === "object") {
        const nestedOutput = (resultNode as any).output_url;
        if (typeof nestedOutput === "string" && nestedOutput.trim()) return nestedOutput;
        const nestedUrl = (resultNode as any).url;
        if (typeof nestedUrl === "string" && nestedUrl.trim()) return nestedUrl;
      }
    }
    return null;
  }, []);

  const pickPreviewBase64 = useCallback((result: any): string | null => {
    if (!result || typeof result !== "object") return null;
    const data = result.data && typeof result.data === "object" ? result.data : null;
    const candidates: unknown[] = [
      (result as any).image_base64,
      (result as any).output_base64,
      data ? (data as any).image_base64 : null,
      data ? (data as any).output_base64 : null,
      data ? (data as any).base64 : null,
      data ? (data as any).image : null,
    ];
    for (const value of candidates) {
      if (typeof value === "string" && value.trim()) {
        const trimmed = value.trim();
        if (trimmed.startsWith("data:image/")) return trimmed;
        return `data:image/png;base64,${trimmed}`;
      }
    }
    return null;
  }, []);

  const scheduleUpdate = useCallback((fn: () => Promise<void>) => {
    pendingUpdateRef.current = fn;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(async () => {
      const next = pendingUpdateRef.current;
      pendingUpdateRef.current = null;
      debounceTimerRef.current = null;
      if (next) {
        try {
          await next();
        } catch (err: any) {
          setError(err?.message || "Failed to update");
        }
      }
    }, UPDATE_DEBOUNCE_MS);
  }, []);

  const startPreviewLoop = useCallback(async (apiKey: string, initialPrompt?: string, sourceStream?: MediaStream | null) => {
    if (!apiKey) return;

    if (previewLoopIntervalRef.current) {
      clearInterval(previewLoopIntervalRef.current);
      previewLoopIntervalRef.current = null;
    }
    setConnectionState("preview_loop");
    setError(null);
    drawPreviewStatus("Starting renderer...");
    previewApiKeyRef.current = apiKey;
    
    // Start preview loop using DecartStudioEngine as fallback
    const engine = new DecartStudioEngine({ apiKey, mode: "preview", enableFallback: true });
    previewEngineRef.current = engine;

    let startupError: string | null = null;

    const tick = async (): Promise<boolean> => {
      // Skip (don't queue) if a submit is already in flight — the loop's job
      // is a fresh frame every interval, not a backlog of stale requests
      // firing back-to-back once a slow response finally clears.
      if (previewBusyRef.current) return false;
      previewBusyRef.current = true;
      try {
        const imageUrl = await capturePreviewInputImage(sourceStream);
        if (!imageUrl) {
          drawPreviewStatus("Waiting for camera frame...");
        }
        const result = await engine.submit({
          prompt: withIdentityLock(initialPrompt || "Enhance the video slightly"),
          mode: "preview",
          imageUrl,
        });

        setPreviewResult(result);

        if (isOfflineFallback(result)) {
          // Fallback output is still a tracked, usable preview result (no
          // real key/capacity available) — surface it instead of treating
          // it as a hard failure that blocks the loop from ever starting.
          const backendNote = String(
            result?.error ||
            result?.metadata?.error ||
            "Preview backend returned fallback output",
          );
          drawPreviewStatus(`Preview running in fallback mode: ${backendNote}`);
          return true;
        }

        const frameSource = pickPreviewUrl(result) ?? pickPreviewBase64(result);
        if (frameSource) {
          setPreviewOutputUrl(frameSource);
          try {
            await drawPreviewFromUrl(frameSource);
          } catch (drawErr) {
            console.warn("[Preview Loop] Draw failed:", drawErr);
          }
          return true;
        }

        if (!result.success && result.error) {
          console.warn("[Preview Loop] Error:", result.error);
          drawPreviewStatus("Waiting for preview frame...");
          return false;
        }

        drawPreviewStatus("Waiting for preview frame...");
      } catch (err) {
        console.warn("[Preview Loop] Failed:", err);
        startupError = err instanceof Error ? err.message : "Preview request failed";
        drawPreviewStatus("Retrying preview request...");
      } finally {
        previewBusyRef.current = false;
      }
      return false;
    };

    let firstFrameReady = false;
    for (let i = 0; i < 3 && !firstFrameReady; i++) {
      firstFrameReady = await tick();
      if (!firstFrameReady && i < 2) {
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    }

    if (!firstFrameReady) {
      const message = startupError || "Preview did not return a frame. Falling back is recommended.";
      setError(message);
      throw new Error(message);
    }

    previewLoopIntervalRef.current = setInterval(() => {
      void tick();
    }, PREVIEW_LOOP_INTERVAL_MS);
  }, [drawPreviewFromUrl, drawPreviewStatus, pickPreviewUrl, pickPreviewBase64, isOfflineFallback, capturePreviewInputImage]);

  const stopPreviewLoop = useCallback(() => {
    if (previewLoopIntervalRef.current) {
      clearInterval(previewLoopIntervalRef.current);
      previewLoopIntervalRef.current = null;
    }
    previewEngineRef.current = null;
    previewApiKeyRef.current = "";
    try { previewInputVideoRef.current?.pause(); } catch {}
    if (previewInputVideoRef.current) {
      previewInputVideoRef.current.srcObject = null;
      try { previewInputVideoRef.current.parentNode?.removeChild(previewInputVideoRef.current); } catch {}
    }
    previewInputVideoRef.current = null;
    previewInputCanvasRef.current = null;
    setPreviewOutputUrl(null);
    setPreviewResult(null);
  }, []);

  const connect = useCallback(async (apiKey: string, onRemoteStream: (stream: MediaStream) => void, initialPrompt?: string, options?: { receiveOnly?: boolean; lite?: boolean }) => {
    let capturedStream: MediaStream | undefined;
    try {

      setConnectionState("connecting");
      setError(null);

      // Lucy 2.5 native per @decartai/sdk 0.1.13: width/height/fps are plain
      // numbers on the model definition (NOT MediaTrackConstraint objects).
      // Native = 1280×720 @ 30fps.
      const model = models.realtime("lucy-2.5");
      const nativeW = Number((model as any).width?.ideal ?? (model as any).width?.max ?? (model as any).width) || 1280;
      const nativeH = Number((model as any).height?.ideal ?? (model as any).height?.max ?? (model as any).height) || 720;
      const nativeFps = Number((model as any).fps?.max ?? (model as any).fps?.ideal ?? (model as any).fps) || 30;

      let stream: MediaStream | undefined;

      // In receive-only mode (e.g. OBS), create a silent dummy stream
      // instead of requesting camera/mic which requires a user gesture
      if (options?.receiveOnly) {
        const canvas = document.createElement("canvas");
        // Match model native so the SDK doesn't renegotiate the output track.
        canvas.width = nativeW;
        canvas.height = nativeH;
        const ctx = canvas.getContext("2d");
        // Draw at 2fps (not 60) — captureStream just needs *some* activity to
        // keep the track alive; we don't ship these frames anywhere.
        let animating = true;
        const drawFrame = () => {
          if (!animating) return;
          if (ctx) {
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
          }
        };
        drawFrame();
        const drawInterval = setInterval(drawFrame, 500);
        stream = canvas.captureStream(2);
        const stopFn = () => {
          animating = false;
          clearInterval(drawInterval);
        };
        (stream as any)._stopAnimation = stopFn;
        stopAnimationRef.current = stopFn;
      } else {
        // Three-rung capture ladder. Lite is auto-selected on weak hardware
        // (see DeepfakeStudio liteMode detection); ?hi=1 forces full quality.
        // ALL rungs use `ideal`-only for w/h — no `max` — so cameras that
        // don't expose the exact requested mode negotiate the closest one
        // instead of throwing OverconstrainedError (the #1 connect failure
        // on cheap USB webcams and 4:3-only integrated cams).
        // The `advanced: [{ frameRate }]` hint is removed — it's a hard
        // override on Safari + some Android Chromium and also throws
        // OverconstrainedError. `frameRate.ideal` alone is enough for the
        // browser to prefer the target fps.
        const hi =
          typeof window !== "undefined" &&
          new URLSearchParams(window.location.search).get("hi") === "1";
        const lite = options?.lite === true;
        const videoConstraints: MediaTrackConstraints = hi
          ? {
              frameRate: { ideal: nativeFps, max: nativeFps },
              width: { ideal: nativeW },
              height: { ideal: nativeH },
            }
          : lite
          ? {
              // Lite: trade resolution, keep frame rate healthy for lip sync.
              frameRate: { ideal: 20, max: 24 },
              width: { ideal: 640 },
              height: { ideal: 360 },
            }
          : {
              // Mid-tier default: 960×540 @ 24fps — comfortably under model
              // native so browser downscale is a no-op, and paced under 30fps
              // to keep encoder budget headroom.
              frameRate: { ideal: 24, max: nativeFps },
              width: { ideal: 960 },
              height: { ideal: 540 },
            };
        stream = await navigator.mediaDevices.getUserMedia({
          // Lipsync accuracy depends on the model reading raw vocal timing —
          // noiseSuppression/autoGainControl are both known to smear or gate
          // transients (the exact cues that drive mouth-shape timing).
          // echoCancellation stays on: it targets acoustic feedback, not
          // voice fidelity, and protects anyone not on headphones.
          audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
          video: videoConstraints,
        });
      }
      capturedStream = stream;


      const client = createDecartClient({ apiKey });
      clientRef.current = client;

      // Hard 12s timeout on connect — a hung WebRTC handshake otherwise
      // spins forever and users just see "Loading" with no recourse.
      const connectPromise = client.realtime.connect(stream, {
        model,
        // Pin explicitly instead of leaving it to Decart's default: h264 has
        // near-universal hardware decode support (lower, more consistent
        // decode latency than vp9 on weak/mobile hardware), and 720p matches
        // our own capture ceiling in every quality tier — requesting 1080p
        // here would just add encode/decode work with nothing upstream ever
        // sending more than 720p worth of detail.
        preferredVideoCodec: "h264",
        resolution: "720p",
        onRemoteStream: (transformedStream: MediaStream) => {
          onRemoteStream(transformedStream);
        },
        initialState: {
          prompt: {
            text: withIdentityLock(initialPrompt || "Enhance the video slightly"),
            enhance: true,
          },
        },
      });
      const realtimeClient = await Promise.race([
        connectPromise,
        // 20s (was 12s). Cold-start Decart handshake completes in 2–4s; the
        // extra headroom covers the case where a previous PeerConnection is
        // still closing (rapid disconnect → reconnect) and the browser
        // serializes the new SDP/ICE round-trip behind it.
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Connection timed out")), 20000),
        ),
      ]);

      realtimeClient.on("connectionChange", (state: ConnectionState) => {
        setConnectionState(state);
      });

      realtimeClient.on("error", (err: any) => {
        const message = err?.message || "Unknown error";
        console.error("Decart error:", err);
        setError(message);
      });

      realtimeClientRef.current = realtimeClient;
      setConnectionState("connected");



      return { stream, realtimeClient };
    } catch (err: any) {
      // Live connect must fail loudly so caller can release session lock + timer.
      const message = err?.message || "Failed to connect to Decart realtime";
      setError(message);
      // Clean up camera + SDK client on failure.
      try { stopAnimationRef.current?.(); stopAnimationRef.current = null; } catch {}
      try { capturedStream?.getTracks().forEach((t) => t.stop()); } catch {}
      try { realtimeClientRef.current?.disconnect?.(); } catch {}
      realtimeClientRef.current = null;
      setConnectionState("disconnected");
      throw err;
    }

  }, []);

  const set = useCallback(async (input: SetInput) => {
    if (!realtimeClientRef.current) return;
    try {
      await realtimeClientRef.current.set(input);
    } catch (err: any) {
      const message = err?.message || "Failed to update";
      console.warn("[Lucy] realtime set failed", message);
      setError(message);
    }
  }, []);

  const setImage = useCallback(
    async (image: Blob | File | string | null, options?: { prompt?: string; enhance?: boolean }) => {
      if (!realtimeClientRef.current) return;
      // Debounced: rapid preset/image switches collapse to the last one only.
      scheduleUpdate(async () => {
        await realtimeClientRef.current.setImage(image, {
          prompt: withIdentityLock(options?.prompt),
          enhance: options?.enhance ?? true,
        });
      });
    },
    [scheduleUpdate],
  );

  const setPrompt = useCallback(
    async (prompt: string, enhance = true) => {
      if (!realtimeClientRef.current) return;
      scheduleUpdate(async () => {
        await realtimeClientRef.current.setPrompt(withIdentityLock(prompt), { enhance });
      });
    },
    [scheduleUpdate],
  );

  // Serializes with the loop's tick() (shared previewBusyRef) so a
  // preset/prompt/image change never fires a Decart request while a loop
  // tick is already mid-flight. Bounded to the loop's own 15s submit
  // ceiling so a stuck lock can't wedge the UI forever.
  const acquirePreviewSlot = useCallback(async () => {
    const deadline = Date.now() + 16000;
    while (previewBusyRef.current && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 120));
    }
    previewBusyRef.current = true;
  }, []);

  const applyStudioRequest = useCallback(async (options: {
    prompt: string;
    image?: Blob | File | string | null;
    enhance?: boolean;
    mode?: "preview" | "live" | string;
  }) => {
    const mode = (options.mode || "live").toLowerCase();
    const promptText = withIdentityLock(options.prompt);

    if (mode === "live" && realtimeClientRef.current) {
      if (options.image) {
        await realtimeClientRef.current.setImage(options.image, {
          prompt: promptText,
          enhance: options.enhance ?? true,
        });
      } else {
        await realtimeClientRef.current.setPrompt(promptText, { enhance: options.enhance ?? true });
      }
      return { success: true, mode: "live" as const, outputUrl: null };
    }

    let imageUrl: string | null = null;
    if (options.image) {
      if (typeof options.image === "string") {
        imageUrl = options.image;
      } else {
        imageUrl = await new Promise<string | null>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
          reader.onerror = () => reject(new Error("Failed to read image"));
          reader.readAsDataURL(options.image as Blob);
        });
      }
    }

    await acquirePreviewSlot();
    try {
      // Reuse the active preview loop's engine/key when one exists so this
      // authenticates as the same minted Decart credential the loop is
      // using. A fresh engine built from "elite-decart-studio-config" (never
      // written anywhere) or VITE_DECART_API_KEY (never set) always resolved
      // to an empty key — every preset/prompt/image action in preview mode
      // silently no-op'd into the offline fallback instead of really applying.
      const engine = previewEngineRef.current
        ?? new DecartStudioEngine({ apiKey: previewApiKeyRef.current, mode, enableFallback: true });

      const result = await engine.submit({
        prompt: promptText,
        mode,
        imageUrl,
      });

      const previewUrl = mode === "preview" ? pickPreviewUrl(result) ?? pickPreviewBase64(result) : null;
      if (previewUrl) {
        setPreviewOutputUrl(previewUrl);
        try {
          await drawPreviewFromUrl(previewUrl);
          setConnectionState("preview_loop");
        } catch (drawErr) {
          console.warn("[Preview] Draw failed:", drawErr);
        }
      } else if (mode === "preview") {
        // No renderable frame came back — most commonly a missing/invalid API
        // key routing us into the engine's offline fallback. Still push a
        // status frame to the output panel instead of leaving it blank.
        const backendNote = String(
          result?.error ||
          (result as any)?.metadata?.error ||
          "Studio backend returned fallback output",
        );
        drawPreviewStatus(isOfflineFallback(result) ? `Preview running in fallback mode: ${backendNote}` : backendNote);
        setConnectionState("preview_loop");
      }

      if (!result.success) {
        setError(result.error ?? "Studio request failed");
      }

      return result;
    } finally {
      previewBusyRef.current = false;
    }
  }, [acquirePreviewSlot, drawPreviewFromUrl, drawPreviewStatus, isOfflineFallback, pickPreviewUrl, pickPreviewBase64]);

  const disconnect = useCallback(async () => {
    // Cancel any pending debounced update
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    pendingUpdateRef.current = null;
    
    // Stop preview loop
    stopPreviewLoop();
    try { previewStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
    previewStreamRef.current = null;
    setPreviewStream(null);
    previewCanvasRef.current = null;
    previewCtxRef.current = null;
    
    // Stop the receive-only canvas animation loop if it was started
    if (stopAnimationRef.current) {
      stopAnimationRef.current();
      stopAnimationRef.current = null;
    }
    if (realtimeClientRef.current) {
      realtimeClientRef.current.disconnect();
      realtimeClientRef.current = null;
    }
    setConnectionState("disconnected");
  }, [stopPreviewLoop]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopPreviewLoop();
      if (realtimeClientRef.current) realtimeClientRef.current.disconnect();
      try { previewStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
      previewStreamRef.current = null;
      previewCanvasRef.current = null;
      previewCtxRef.current = null;
    };
  }, [stopPreviewLoop]);

  return {
    connectionState,
    error,
    previewOutputUrl,
    previewResult,
    previewStream,
    connect,
    startPreviewLoop,
    stopPreviewLoop,
    disconnect,
    set,
    setImage,
    setPrompt,
    applyStudioRequest,
  };
}
