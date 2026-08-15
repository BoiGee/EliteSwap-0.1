/// <reference lib="webworker" />
// Off-main-thread OBS broadcast encoder.
//
// Two paths, picked per session by the main thread:
//   • Path A — WebCodecs H.264 (Chromium/Edge): hardware encode, ~3 ms/frame,
//     inter-frame compression, sub-100 ms latency end-to-end.
//   • Path B — JPEG (everywhere else): per-frame baseline, retained as a
//     universal fallback for Safari/Firefox + any browser without VideoEncoder.
//
// Both paths produce a base64 string (Realtime broadcast is JSON-only on the
// wire) but H.264 chunks are typically <2 KB even at 30 fps.

interface InitMsg {
  kind: "init";
  codec: "h264" | "jpeg";
  width?: number;
  height?: number;
  bitrate?: number;
  framerate?: number;
}

interface EncodeMsg {
  kind: "encode";
  id: number;
  bitmap?: ImageBitmap;
  frame?: VideoFrame;
  srcWidth: number;
  srcHeight: number;
  /** Sender-side capture timestamp (performance.now). Used for latency telemetry. */
  ts: number;
  /** Force keyframe (called periodically + on first send for fast OBS sync). */
  keyFrame?: boolean;
}

interface BitrateMsg {
  kind: "bitrate";
  bitrate: number;
}

interface ReconfigureMsg {
  kind: "reconfigure";
  width: number;
  height: number;
}

type IncomingMsg = InitMsg | EncodeMsg | BitrateMsg | ReconfigureMsg;

interface EncodeReply {
  kind: "frame";
  id: number;
  width: number;
  height: number;
  data: string;
  bytes: number;
  encodeMs: number;
  /** "key" or "delta" for H.264; always "key" for JPEG. */
  type: "key" | "delta";
  ts: number;
  /** H.264 only. Carries the avcC config record (base64) on the first keyframe. */
  config?: string;
  error?: string;
}

interface ReadyReply {
  kind: "ready";
  codec: "h264" | "jpeg";
  width?: number;
  height?: number;
}

const post = (msg: EncodeReply | ReadyReply) =>
  (self as unknown as Worker).postMessage(msg);

// ---------- Shared helpers ----------
const bytesToBase64 = (bytes: Uint8Array): string => {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + CHUNK) as unknown as number[],
    );
  }
  return btoa(s);
};

// ---------- JPEG path (legacy / universal) ----------
let jpegEmaMs = 10;
const jpegAlpha = 0.2;
// Black-frame guard state: a black frame (camera covered, permission
// dropped) is a persistent condition, not a per-frame flicker, so checking
// it a few times a second is plenty responsive. Every getImageData() call
// forces a synchronous GPU->CPU readback stall — doing 9 of them on every
// single frame was a real, avoidable cost exactly on the low-end-hardware
// path (JPEG fallback) that can least afford it.
let lastBlackFrameCheckAt = 0;
let lastBlackFrameBright = 1;
const BLACK_FRAME_CHECK_INTERVAL_MS = 750;
const pickJpegQuality = (ms: number) => (ms < 12 ? 0.5 : ms < 25 ? 0.45 : 0.4);
const pickJpegMaxWidth = (ms: number) => (ms < 15 ? 854 : ms < 30 ? 720 : 640);

const encodeJpeg = async (msg: EncodeMsg): Promise<EncodeReply> => {
  const { id, bitmap, frame, srcWidth, srcHeight, ts } = msg;
  const t0 = performance.now();
  const quality = pickJpegQuality(jpegEmaMs);
  const maxW = pickJpegMaxWidth(jpegEmaMs);
  const scale = Math.min(1, maxW / srcWidth);
  const width = Math.max(2, Math.round(srcWidth * scale));
  const height = Math.max(2, Math.round(srcHeight * scale));

  try {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("OffscreenCanvas 2D ctx unavailable");

    if (bitmap) {
      ctx.drawImage(bitmap, 0, 0, width, height);
      bitmap.close();
    } else if (frame) {
      ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0, width, height);
      frame.close();
    } else {
      throw new Error("no bitmap or frame");
    }

    // Black-frame guard, throttled — see BLACK_FRAME_CHECK_INTERVAL_MS above.
    let bright = lastBlackFrameBright;
    if (t0 - lastBlackFrameCheckAt >= BLACK_FRAME_CHECK_INTERVAL_MS) {
      bright = 0;
      try {
        const xs = [width >> 2, width >> 1, (width * 3) >> 2];
        const ys = [height >> 2, height >> 1, (height * 3) >> 2];
        outer: for (const x of xs) {
          for (const y of ys) {
            const px = ctx.getImageData(x, y, 1, 1).data;
            if (px[0] + px[1] + px[2] > 12) {
              bright = 1;
              break outer;
            }
          }
        }
      } catch {
        bright = 1;
      }
      lastBlackFrameCheckAt = t0;
      lastBlackFrameBright = bright;
    }
    if (!bright) throw new Error("black frame");

    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
    const data = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
    const encodeMs = Math.round(performance.now() - t0);
    jpegEmaMs = jpegAlpha * encodeMs + (1 - jpegAlpha) * jpegEmaMs;
    return {
      kind: "frame",
      id,
      width,
      height,
      data,
      bytes: blob.size,
      encodeMs,
      type: "key",
      ts,
    };
  } catch (err: any) {
    try { bitmap?.close(); } catch {}
    try { frame?.close(); } catch {}
    return {
      kind: "frame",
      id,
      width,
      height,
      data: "",
      bytes: 0,
      encodeMs: Math.round(performance.now() - t0),
      type: "key",
      ts,
      error: err?.message || "encode failed",
    };
  }
};

// ---------- H.264 path (WebCodecs) ----------
let h264Encoder: VideoEncoder | null = null;
let h264Width = 854;
let h264Height = 480;
let h264Bitrate = 1_500_000;
let h264Framerate = 30;
// Latest pending message awaiting encoder output (one-shot map keyed by ts).
const h264Pending = new Map<number, { id: number; ts: number; t0: number }>();
// Pending VideoFrame metadata so we can map encoder.output() chunks back to ids.
let h264OutputQueue: { id: number; ts: number; t0: number }[] = [];
// avcC description (base64) emitted with the first chunk's metadata; we cache
// it and send it with EVERY keyframe so a late OBS subscriber can decode.
let h264ConfigB64: string | null = null;

const setupH264 = async (init: InitMsg) => {
  h264Width = Math.max(2, init.width ?? 854);
  h264Height = Math.max(2, init.height ?? 480);
  h264Bitrate = init.bitrate ?? 1_500_000;
  h264Framerate = init.framerate ?? 30;

  // Probe support before constructing.
  const config: VideoEncoderConfig = {
    codec: "avc1.42E01F", // H.264 Baseline 3.1 — universally decodable
    width: h264Width,
    height: h264Height,
    bitrate: h264Bitrate,
    framerate: h264Framerate,
    latencyMode: "realtime",
    hardwareAcceleration: "prefer-hardware",
    avc: { format: "avc" }, // emits avcC description for the receiver
  };

  const support = await (VideoEncoder as any).isConfigSupported(config);
  if (!support?.supported) throw new Error("H.264 config not supported");

  h264Encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const pending = h264OutputQueue.shift();
      if (!pending) return;
      // Cache description on first output so we can re-send with every keyframe.
      if (meta?.decoderConfig?.description && !h264ConfigB64) {
        const desc = meta.decoderConfig.description as ArrayBuffer | ArrayBufferView;
        const descBytes = desc instanceof ArrayBuffer
          ? new Uint8Array(desc)
          : new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength);
        h264ConfigB64 = bytesToBase64(descBytes);
      }
      const buf = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buf);
      const data = bytesToBase64(buf);
      post({
        kind: "frame",
        id: pending.id,
        width: h264Width,
        height: h264Height,
        data,
        bytes: chunk.byteLength,
        encodeMs: Math.round(performance.now() - pending.t0),
        type: chunk.type === "key" ? "key" : "delta",
        ts: pending.ts,
        config: chunk.type === "key" ? h264ConfigB64 ?? undefined : undefined,
      });
    },
    error: (err) => {
      // On encoder error, drain the queue with error replies so the main
      // thread doesn't leak in-flight slots.
      const drained = h264OutputQueue;
      h264OutputQueue = [];
      for (const p of drained) {
        post({
          kind: "frame",
          id: p.id,
          width: h264Width,
          height: h264Height,
          data: "",
          bytes: 0,
          encodeMs: 0,
          type: "delta",
          ts: p.ts,
          error: err?.message || "encoder error",
        });
      }
      try { h264Encoder?.close(); } catch {}
      h264Encoder = null;
    },
  });
  h264Encoder.configure(config);
  post({ kind: "ready", codec: "h264", width: h264Width, height: h264Height });
};

const encodeH264 = async (msg: EncodeMsg) => {
  const { id, bitmap, frame, ts, keyFrame } = msg;
  const t0 = performance.now();
  if (!h264Encoder || h264Encoder.state !== "configured") {
    // Encoder not ready — drop with an error reply so the main thread
    // releases its in-flight slot.
    try { bitmap?.close(); } catch {}
    try { frame?.close(); } catch {}
    post({
      kind: "frame", id, width: h264Width, height: h264Height,
      data: "", bytes: 0, encodeMs: 0, type: "delta", ts,
      error: "encoder not ready",
    });
    return;
  }

  // VideoEncoder needs a VideoFrame. If the main thread sent an ImageBitmap,
  // wrap it. (Source: MSTP gives us VideoFrame directly; we keep the bitmap
  // path for browsers that have WebCodecs but not MSTP.)
  let vf: VideoFrame;
  try {
    if (frame) {
      vf = frame;
    } else if (bitmap) {
      vf = new VideoFrame(bitmap, { timestamp: Math.round(ts * 1000) });
      bitmap.close();
    } else {
      throw new Error("no source");
    }
  } catch (err: any) {
    post({
      kind: "frame", id, width: h264Width, height: h264Height,
      data: "", bytes: 0, encodeMs: 0, type: "delta", ts,
      error: err?.message || "frame wrap failed",
    });
    return;
  }

  h264OutputQueue.push({ id, ts, t0 });
  try {
    h264Encoder.encode(vf, { keyFrame });
  } catch (err: any) {
    // Best-effort: pop our slot back since output() won't fire for this one.
    h264OutputQueue.pop();
    post({
      kind: "frame", id, width: h264Width, height: h264Height,
      data: "", bytes: 0, encodeMs: 0, type: "delta", ts,
      error: err?.message || "encode threw",
    });
  } finally {
    vf.close();
  }
};

// ---------- Dispatch ----------
let activeCodec: "h264" | "jpeg" = "jpeg";

self.onmessage = async (e: MessageEvent<IncomingMsg>) => {
  const msg = e.data;
  if (!msg) return;

  if (msg.kind === "init") {
    activeCodec = msg.codec;
    if (msg.codec === "h264") {
      try {
        await setupH264(msg);
      } catch (err) {
        console.warn("[obsEncoder] H.264 init failed, falling back to JPEG:", err);
        activeCodec = "jpeg";
        post({ kind: "ready", codec: "jpeg" });
      }
    } else {
      post({ kind: "ready", codec: "jpeg" });
    }
    return;
  }

  if (msg.kind === "bitrate") {
    if (h264Encoder?.state === "configured") {
      try {
        h264Encoder.configure({
          codec: "avc1.42E01F",
          width: h264Width,
          height: h264Height,
          bitrate: msg.bitrate,
          framerate: h264Framerate,
          latencyMode: "realtime",
          hardwareAcceleration: "prefer-hardware",
          avc: { format: "avc" },
        });
        h264Bitrate = msg.bitrate;
      } catch {}
    }
    return;
  }

  if (msg.kind === "reconfigure") {
    // Orientation flip mid-broadcast — rebuild the encoder at the new size.
    // Reset the avcC cache so the next keyframe carries a fresh decoder
    // description (the receiver re-inits its decoder when width/height change).
    try { h264Encoder?.close(); } catch {}
    h264Encoder = null;
    h264OutputQueue = [];
    h264ConfigB64 = null;
    if (activeCodec === "h264") {
      try {
        await setupH264({
          kind: "init",
          codec: "h264",
          width: msg.width,
          height: msg.height,
          bitrate: h264Bitrate,
          framerate: h264Framerate,
        });
      } catch (err) {
        console.warn("[obsEncoder] reconfigure failed:", err);
      }
    } else {
      // JPEG path — the next encode just uses the new srcWidth/srcHeight from
      // the main thread, but emit a ready ping so telemetry stays accurate.
      post({ kind: "ready", codec: "jpeg", width: msg.width, height: msg.height });
    }
    return;
  }

  if (msg.kind === "encode") {
    if (activeCodec === "h264") {
      await encodeH264(msg);
    } else {
      const reply = await encodeJpeg(msg);
      post(reply);
    }
  }
};

export {};
