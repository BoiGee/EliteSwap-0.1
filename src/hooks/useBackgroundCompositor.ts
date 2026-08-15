import { useCallback, useEffect, useRef, useState } from "react";
import { createProgram, createTexture, hexToRgb01 } from "@/lib/backgroundCompositor/gl";
import type { BackgroundSegmentationMessage, BackgroundSegmentationResponse } from "@/workers/backgroundSegmentation.worker";

export type BackgroundMode = "segmentation" | "chromakey";
export type QualityTier = "lite" | "mid" | "hi";

export interface BackgroundConfig {
  imageUrl: string;
  mode: BackgroundMode;
  chromaKeyColor?: string; // hex, e.g. "#00b140"
}

// Segmentation request cadence, ms. Adapted at runtime from measured
// inference time; these are the floor/ceiling either side of that.
const SEGMENT_INTERVAL_FLOOR_MS: Record<QualityTier, number> = { lite: 140, mid: 90, hi: 60 };
const SEGMENT_INTERVAL_CEILING_MS = 500;
const OUTPUT_FPS: Record<QualityTier, number> = { lite: 20, mid: 24, hi: 30 };

interface CompositorState {
  outputStream: MediaStream | null;
  active: boolean;
  degraded: boolean; // inference is consistently too slow for this device
  lastInferenceMs: number | null;
}

/**
 * Composites a custom background behind the person in `sourceStream` (the
 * live Decart output). When `config` is null this is a true no-op pass-
 * through — no canvas, no worker, zero added cost — which matters since the
 * large majority of sessions never touch this feature at all.
 *
 * When active: segmentation mode runs MediaPipe's ImageSegmenter in a Web
 * Worker (CPU delegate — no GPU dependency) on a throttled, adaptive
 * cadence, reusing the last mask between updates since a person's silhouette
 * barely changes frame-to-frame. Chroma-key mode needs no ML at all — the
 * alpha is computed inline in the WebGL shader every frame, essentially
 * free. Either way, the actual per-frame compositing (blend background +
 * foreground by the alpha) is one GPU draw call.
 */
export function useBackgroundCompositor(config: BackgroundConfig | null, qualityTier: QualityTier = "mid") {
  const [state, setState] = useState<CompositorState>({
    outputStream: null,
    active: false,
    degraded: false,
    lastInferenceMs: null,
  });

  const sourceRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const glRef = useRef<WebGLRenderingContext | null>(null);
  const programRef = useRef<WebGLProgram | null>(null);
  const texturesRef = useRef<{ video: WebGLTexture; background: WebGLTexture; mask: WebGLTexture } | null>(null);
  const uniformsRef = useRef<Record<string, WebGLUniformLocation | null>>({});
  const bgImageRef = useRef<HTMLImageElement | null>(null);
  const bgImageUrlRef = useRef<string | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const workerReadyRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const lastDrawAtRef = useRef(0);
  const lastSegmentAtRef = useRef(0);
  const segmentBusyRef = useRef(false);
  const emaInferenceRef = useRef<number | null>(null);
  // True only once a REAL segmentation result has ever been applied. Until
  // then (initial model warmup, or the worker never becoming ready at all —
  // slow/failed WASM+model fetch, unsupported browser), segmentation mode
  // forces the shader into passthrough (uMode 2, alpha always 1) instead of
  // sampling the mask texture at all. This is deliberately redundant with
  // the mask texture's white placeholder above — two independent mechanisms
  // that both have to fail for the person/swap to ever be hidden.
  const hasReceivedMaskRef = useRef(false);
  const nextRequestIdRef = useRef(1);
  const configRef = useRef<BackgroundConfig | null>(config);
  const qualityTierRef = useRef<QualityTier>(qualityTier);
  const mountedRef = useRef(true);

  configRef.current = config;
  qualityTierRef.current = qualityTier;

  const ensureVideo = useCallback(() => {
    if (!videoRef.current) {
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.autoplay = true;
      v.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";
      document.body.appendChild(v);
      videoRef.current = v;
    }
    return videoRef.current;
  }, []);

  const ensureCanvasAndGl = useCallback(() => {
    if (canvasRef.current && glRef.current) return { canvas: canvasRef.current, gl: glRef.current };
    const canvas = document.createElement("canvas");
    canvas.width = 960;
    canvas.height = 540;
    const gl = canvas.getContext("webgl", { alpha: false, desynchronized: true }) as WebGLRenderingContext | null;
    if (!gl) throw new Error("WebGL unavailable");
    const program = createProgram(gl);
    gl.useProgram(program);

    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(program, "aPosition");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    // Each texture must be created while ITS OWN unit is active. createTexture()
    // binds whatever it creates to the currently-active unit — without these
    // activeTexture() calls, all three would land on unit 0 (the default),
    // and units 1/2 would have nothing bound at all until the background
    // image loads / the first segmentation result arrives. Sampling an
    // unbound WebGL texture unit returns (0,0,0,0), which zeroed out the
    // mask's alpha exactly like the black-placeholder bug this was meant to
    // fix — confirmed by testing: setting a white placeholder alone did not
    // change the observed output, because it was never actually bound to
    // unit 2 in the first place.
    gl.activeTexture(gl.TEXTURE0);
    const videoTex = createTexture(gl);
    gl.activeTexture(gl.TEXTURE1);
    const bgTex = createTexture(gl);
    // White placeholder: the mask's red channel is read directly as alpha
    // (fully-foreground = 1). Before the first real segmentation result
    // arrives — or if the worker never becomes ready at all (slow/failed
    // model load, unsupported browser) — this must default to showing the
    // person/swap, not to a black placeholder that reads as alpha=0 and
    // hides them behind the background image indefinitely.
    gl.activeTexture(gl.TEXTURE2);
    const maskTex = createTexture(gl, [255, 255, 255, 255]);
    texturesRef.current = { video: videoTex, background: bgTex, mask: maskTex };

    uniformsRef.current = {
      uVideo: gl.getUniformLocation(program, "uVideo"),
      uBackground: gl.getUniformLocation(program, "uBackground"),
      uMask: gl.getUniformLocation(program, "uMask"),
      uMode: gl.getUniformLocation(program, "uMode"),
      uKeyColor: gl.getUniformLocation(program, "uKeyColor"),
      uKeySimilarity: gl.getUniformLocation(program, "uKeySimilarity"),
      uKeySmoothness: gl.getUniformLocation(program, "uKeySmoothness"),
    };
    gl.uniform1i(uniformsRef.current.uVideo, 0);
    gl.uniform1i(uniformsRef.current.uBackground, 1);
    gl.uniform1i(uniformsRef.current.uMask, 2);

    canvasRef.current = canvas;
    glRef.current = gl;
    programRef.current = program;
    return { canvas, gl };
  }, []);

  const loadBackgroundImage = useCallback((url: string) => {
    if (bgImageUrlRef.current === url && bgImageRef.current) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      bgImageRef.current = img;
      bgImageUrlRef.current = url;
      const gl = glRef.current;
      const tex = texturesRef.current?.background;
      if (gl && tex) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      }
    };
    img.onerror = () => console.warn("[backgroundCompositor] failed to load background image", url);
    img.src = url;
  }, []);

  const ensureWorker = useCallback(() => {
    if (workerRef.current) return workerRef.current;
    const worker = new Worker(new URL("../workers/backgroundSegmentation.worker.ts", import.meta.url), {
      type: "module",
    });
    // Without this, a worker that fails to start (model/WASM fetch failure,
    // unsupported browser) never posts "ready" and never posts an "error"
    // message either — it just silently never segments again, leaving the
    // white placeholder mask in place. That's the safe fallback now (see
    // the mask texture above), but still worth surfacing so it's visible in
    // the console instead of looking like AI Background quietly did nothing.
    worker.onerror = (e) => {
      console.warn("[backgroundCompositor] segmentation worker failed to start", e.message);
      workerReadyRef.current = false;
      segmentBusyRef.current = false;
    };
    worker.onmessage = (e: MessageEvent<BackgroundSegmentationResponse>) => {
      const msg = e.data;
      if (msg.kind === "ready") {
        workerReadyRef.current = true;
        return;
      }
      if (msg.kind === "error") {
        console.warn("[backgroundCompositor] segmentation error", msg.message);
        segmentBusyRef.current = false;
        return;
      }
      if (msg.kind === "mask") {
        segmentBusyRef.current = false;
        hasReceivedMaskRef.current = true;
        const prevEma = emaInferenceRef.current;
        emaInferenceRef.current = prevEma == null ? msg.inferenceMs : prevEma * 0.7 + msg.inferenceMs * 0.3;
        if (mountedRef.current) {
          setState((s) => ({ ...s, lastInferenceMs: msg.inferenceMs, degraded: (emaInferenceRef.current ?? 0) > 400 }));
        }
        const gl = glRef.current;
        const tex = texturesRef.current?.mask;
        if (gl && tex) {
          // Normalize the confidence mask (0..1 float) to a Uint8 luminance
          // texture — works on plain WebGL1 with no float-texture extension.
          const bytes = new Uint8Array(msg.mask.length);
          for (let i = 0; i < msg.mask.length; i++) bytes[i] = Math.max(0, Math.min(255, Math.round(msg.mask[i] * 255)));
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, msg.width, msg.height, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, bytes);
        }
      }
    };
    worker.postMessage({ kind: "init" } satisfies BackgroundSegmentationMessage);
    workerRef.current = worker;
    return worker;
  }, []);

  const maybeRequestSegmentation = useCallback((now: number) => {
    const cfg = configRef.current;
    if (!cfg || cfg.mode !== "segmentation") return;
    if (!workerReadyRef.current || segmentBusyRef.current) return;
    const tier = qualityTierRef.current;
    const ema = emaInferenceRef.current;
    const target = ema != null
      ? Math.min(SEGMENT_INTERVAL_CEILING_MS, Math.max(SEGMENT_INTERVAL_FLOOR_MS[tier], ema * 2.5))
      : SEGMENT_INTERVAL_FLOOR_MS[tier];
    if (now - lastSegmentAtRef.current < target) return;
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return;
    lastSegmentAtRef.current = now;
    segmentBusyRef.current = true;
    const id = nextRequestIdRef.current++;
    createImageBitmap(video)
      .then((bitmap) => {
        ensureWorker().postMessage(
          { kind: "frame", id, bitmap, timestampMs: now } satisfies BackgroundSegmentationMessage,
          [bitmap],
        );
      })
      .catch(() => {
        segmentBusyRef.current = false;
      });
  }, [ensureWorker]);

  const draw = useCallback((now: number) => {
    const cfg = configRef.current;
    if (!cfg) return;
    const targetInterval = 1000 / OUTPUT_FPS[qualityTierRef.current];
    if (now - lastDrawAtRef.current < targetInterval) return;
    lastDrawAtRef.current = now;

    const gl = glRef.current;
    const video = videoRef.current;
    const textures = texturesRef.current;
    if (!gl || !video || !textures || !video.videoWidth) return;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, textures.video);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

    const segmentationMode = cfg.mode !== "chromakey" && !hasReceivedMaskRef.current ? 2 : cfg.mode === "chromakey" ? 1 : 0;
    gl.uniform1i(uniformsRef.current.uMode, segmentationMode);
    if (cfg.mode === "chromakey") {
      const [r, g, b] = hexToRgb01(cfg.chromaKeyColor || "#00b140");
      gl.uniform3f(uniformsRef.current.uKeyColor, r, g, b);
      gl.uniform1f(uniformsRef.current.uKeySimilarity, 0.28);
      gl.uniform1f(uniformsRef.current.uKeySmoothness, 0.18);
    }

    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    maybeRequestSegmentation(now);
  }, [maybeRequestSegmentation]);

  const loop = useCallback((now: number) => {
    draw(now);
    rafRef.current = requestAnimationFrame(loop);
  }, [draw]);

  const teardownWorker = useCallback(() => {
    if (workerRef.current) {
      try { workerRef.current.postMessage({ kind: "close" } satisfies BackgroundSegmentationMessage); } catch { /* noop */ }
      workerRef.current.terminate();
      workerRef.current = null;
    }
    workerReadyRef.current = false;
    segmentBusyRef.current = false;
    emaInferenceRef.current = null;
    hasReceivedMaskRef.current = false;
  }, []);

  const teardownActive = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    teardownWorker();
  }, [teardownWorker]);

  // Activate/deactivate compositing when config changes.
  useEffect(() => {
    if (!config) {
      teardownActive();
      setState({ outputStream: sourceRef.current, active: false, degraded: false, lastInferenceMs: null });
      return;
    }

    const video = ensureVideo();
    if (sourceRef.current) video.srcObject = sourceRef.current;
    void video.play().catch(() => {});

    const { canvas } = ensureCanvasAndGl();
    loadBackgroundImage(config.imageUrl);
    if (config.mode === "segmentation") {
      ensureWorker();
    } else {
      // Switching away from AI Background mid-session (e.g. to Green
      // Screen) — release the MediaPipe WASM worker and loaded model
      // instead of leaving them resident in memory for the rest of the
      // session.
      teardownWorker();
    }

    if (!rafRef.current) rafRef.current = requestAnimationFrame(loop);

    const fps = OUTPUT_FPS[qualityTierRef.current];
    const captured = (canvas as HTMLCanvasElement).captureStream(fps);
    setState({ outputStream: captured, active: true, degraded: false, lastInferenceMs: null });

    return () => {
      // Only torn down fully when the effect re-runs due to config changing
      // to null (handled in the branch above) or on unmount (handled below).
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.imageUrl, config?.mode, config?.chromaKeyColor]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      teardownActive();
      if (videoRef.current) {
        try { videoRef.current.pause(); } catch { /* noop */ }
        videoRef.current.srcObject = null;
        try { videoRef.current.parentNode?.removeChild(videoRef.current); } catch { /* noop */ }
      }
    };
  }, [teardownActive]);

  const setSource = useCallback((stream: MediaStream | null) => {
    sourceRef.current = stream;
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      if (stream) void videoRef.current.play().catch(() => {});
    }
    // Pass-through when compositing isn't active — the majority case.
    if (!configRef.current) {
      setState((s) => ({ ...s, outputStream: stream }));
    }
  }, []);

  return {
    setSource,
    outputStream: state.outputStream,
    active: state.active,
    degraded: state.degraded,
    lastInferenceMs: state.lastInferenceMs,
  };
}
