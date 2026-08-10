import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Helmet } from "react-helmet-async";

import { supabase } from "@/integrations/supabase/client";
import { obsRelayTopic } from "@/lib/obsTopic";
import {
  decodeBinaryFrame,
  FLAG_KEYFRAME,
  DEFAULT_ICE_SERVERS,
  newPeerId,
  canUseTrackGenerator,
  canUseWebCodecs,
} from "@/lib/obsP2P";

type BrokerPayload = {
  w: number;
  h: number;
  d: string; // base64
  t?: "key" | "delta";
  ts?: number;
  c?: string;
};

const base64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export default function OBSOutput() {
  const [searchParams] = useSearchParams();
  const transparent = searchParams.get("transparent") === "1";
  const apiKey = searchParams.get("key") || "";
  const lowLatency = searchParams.get("lowlatency") === "1";
  // ?broker=1 disables P2P entirely (debugging / forced fallback).
  const forceBroker = searchParams.get("broker") === "1";

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [receiving, setReceiving] = useState(false);
  const [status, setStatus] = useState("connecting");
  // Which transport the receiver is currently using. Drives which DOM element
  // is visible (canvas for broker/fallback, video for P2P+MSTG).
  const [transport, setTransport] = useState<"p2p-video" | "p2p-canvas" | "broker" | null>(null);
  // Mirror of `transport` readable from inside long-lived closures (channel
  // handlers, watchdog interval) without re-subscribing the effect on each
  // transport change. The setState call still drives the UI; the ref keeps
  // the read-side honest.
  const transportRef = useRef<typeof transport>(null);
  const setTransportSafe = (next: typeof transport) => {
    transportRef.current = next;
    setTransport(next);
  };
  const lastFrameRef = useRef<number>(0);

  useEffect(() => {
    if (!apiKey) {
      setStatus("missing key");
      return;
    }

    const viewerId = newPeerId();
    const canDecodeH264 = canUseWebCodecs("decoder");
    const useTrackGenerator = !lowLatency && canUseTrackGenerator() && canDecodeH264;

    const channelName = obsRelayTopic(apiKey);
    const channel = supabase.channel(channelName, {
      config: {
        broadcast: { self: false, ack: false },
        presence: { key: `obs-${viewerId}` },
      },
    });

    // ============================================================
    // Shared decoder / paint state
    // ============================================================
    let videoDecoder: VideoDecoder | null = null;
    let decoderConfigured = false;
    // Track the dimensions the decoder was configured with so we can detect a
    // mid-stream resolution change (e.g. user flips orientation in the studio)
    // and rebuild the decoder + reset the MSTG track / canvas.
    let decoderW = 0;
    let decoderH = 0;
    // Canvas-paint path state (used when MSTG isn't available, or for broker JPEG).
    let latestFrame: VideoFrame | null = null;
    let pendingPaint = false;
    // MSTG path state (Plan M paint fast-path).
    let trackGenerator: any = null; // MediaStreamTrackGenerator
    let trackWriter: WritableStreamDefaultWriter<VideoFrame> | null = null;

    const ctxRef: { ctx: CanvasRenderingContext2D | null } = { ctx: null };
    const ensureCtx = () => {
      if (!ctxRef.ctx && canvasRef.current) {
        ctxRef.ctx = canvasRef.current.getContext("2d");
        if (ctxRef.ctx) ctxRef.ctx.imageSmoothingEnabled = false;
      }
      return ctxRef.ctx;
    };

    const paintLatest = () => {
      pendingPaint = false;
      const frame = latestFrame;
      if (!frame) return;
      const canvas = canvasRef.current;
      const ctx = ensureCtx();
      if (!canvas || !ctx) {
        frame.close();
        latestFrame = null;
        return;
      }
      if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth;
      if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight;
      ctx.drawImage(frame, 0, 0);
      frame.close();
      latestFrame = null;
    };

    const schedulePaint = () => {
      if (pendingPaint) return;
      pendingPaint = true;
      // N8: P2P canvas fallback (no MSTG) is already as low-latency as the
      // transport allows — paint via microtask so we don't add another rAF
      // refresh of delay. Broker fallback keeps rAF to coalesce JPEG decodes.
      const t = transportRef.current;
      const useMicrotask = lowLatency || t === "p2p-canvas" || t === "p2p-video";
      if (useMicrotask) queueMicrotask(paintLatest);
      else requestAnimationFrame(paintLatest);
    };

    // Setup the MediaStreamTrackGenerator path. The browser handles paint —
    // OBS Browser Source captures the <video> element directly via the GPU
    // compositor, which is the lowest-latency option Chromium offers.
    const setupTrackGenerator = () => {
      if (trackGenerator) return;
      try {
        const G = (globalThis as any).MediaStreamTrackGenerator;
        trackGenerator = new G({ kind: "video" });
        trackWriter = trackGenerator.writable.getWriter();
        if (videoRef.current) {
          videoRef.current.srcObject = new MediaStream([trackGenerator]);
          videoRef.current.play().catch(() => {});
        }
        setTransportSafe("p2p-video");
      } catch (err) {
        console.warn("[obs receiver] MSTG setup failed, falling back to canvas", err);
        trackGenerator = null;
        trackWriter = null;
      }
    };

    const setupDecoder = (configBytes: Uint8Array, viaP2P: boolean, w: number, h: number) => {
      if (decoderConfigured) return;
      try { videoDecoder?.close(); } catch {}
      const useMSTG = viaP2P && useTrackGenerator;
      if (useMSTG) setupTrackGenerator();

      videoDecoder = new VideoDecoder({
        output: (frame) => {
          if (trackWriter) {
            // Fast path — write frame directly into the track. Browser paints.
            trackWriter.write(frame).catch(() => {
              try { frame.close(); } catch {}
            });
          } else {
            // Canvas fallback — freshest-frame-wins.
            latestFrame?.close();
            latestFrame = frame;
            schedulePaint();
          }
        },
        error: (err) => {
          console.warn("[obs receiver] decoder error", err);
          decoderConfigured = false;
        },
      });
      videoDecoder.configure({
        codec: "avc1.42E01F",
        description: configBytes.buffer.slice(
          configBytes.byteOffset,
          configBytes.byteOffset + configBytes.byteLength,
        ) as ArrayBuffer,
        optimizeForLatency: true,
        hardwareAcceleration: "prefer-hardware",
      });
      decoderConfigured = true;
      decoderW = w;
      decoderH = h;
    };

    /** Tear down the active decoder + MSTG track when the source resolution
     *  changes mid-stream (e.g. studio orientation flip). The next keyframe's
     *  config bytes will reinitialize everything cleanly. */
    const resetDecoderForResize = () => {
      try { videoDecoder?.close(); } catch {}
      videoDecoder = null;
      decoderConfigured = false;
      decoderW = 0;
      decoderH = 0;
      if (trackWriter) {
        try { trackWriter.close(); } catch {}
        trackWriter = null;
      }
      trackGenerator = null;
      // Drop any in-flight canvas frame so we don't paint a stale-sized one.
      try { latestFrame?.close(); } catch {}
      latestFrame = null;
    };

    // ============================================================
    // Broker path — JPEG (or H.264 over Realtime, pre-Plan-M)
    // ============================================================
    let jpegLatest: BrokerPayload | null = null;
    let jpegDecoding = false;
    const supportsBitmap = typeof createImageBitmap === "function";

    const paintJpeg = async () => {
      if (jpegDecoding) return;
      const payload = jpegLatest;
      if (!payload) return;
      jpegLatest = null;
      jpegDecoding = true;
      try {
        const canvas = canvasRef.current;
        const ctx = ensureCtx();
        if (!canvas || !ctx) return;
        if (canvas.width !== payload.w) canvas.width = payload.w;
        if (canvas.height !== payload.h) canvas.height = payload.h;

        const bytes = base64ToBytes(payload.d);
        const blob = new Blob(
          [bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer],
          { type: "image/jpeg" },
        );
        if (supportsBitmap) {
          const bitmap = await createImageBitmap(blob);
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
        } else {
          const url = URL.createObjectURL(blob);
          const img = new Image();
          await new Promise<void>((res, rej) => {
            img.onload = () => res();
            img.onerror = rej;
            img.src = url;
          });
          ctx.drawImage(img, 0, 0);
          URL.revokeObjectURL(url);
        }
      } catch {
        // ignore single-frame failures
      } finally {
        jpegDecoding = false;
        if (jpegLatest) paintJpeg();
      }
    };

    channel.on("broadcast", { event: "frame" }, (msg) => {
      // If we've already established P2P, ignore broker frames entirely —
      // the studio won't be sending us any anyway, but be defensive.
      if (transportRef.current === "p2p-video" || transportRef.current === "p2p-canvas") return;

      const payload = msg.payload as BrokerPayload;
      if (!payload?.d) return;
      lastFrameRef.current = Date.now();
      setReceiving(true);
      if (!transportRef.current) setTransportSafe("broker");

      const isH264 = canDecodeH264 && payload.t !== undefined && (payload.c || decoderConfigured);

      if (isH264) {
        try {
          // Resolution change mid-stream → tear down the decoder so the next
          // keyframe's config bytes can re-init it at the new dimensions.
          if (decoderConfigured && (payload.w !== decoderW || payload.h !== decoderH)) {
            resetDecoderForResize();
          }
          if (payload.c && !decoderConfigured) {
            setupDecoder(base64ToBytes(payload.c), false, payload.w, payload.h);
          }
          if (!videoDecoder || !decoderConfigured) return;
          const chunk = new EncodedVideoChunk({
            type: payload.t === "key" ? "key" : "delta",
            timestamp: Math.round((payload.ts ?? performance.now()) * 1000),
            data: base64ToBytes(payload.d),
          });
          videoDecoder.decode(chunk);
        } catch (err) {
          console.warn("[obs receiver] broker H.264 decode failed", err);
        }
      } else {
        jpegLatest = payload;
        paintJpeg();
      }
    });

    // ============================================================
    // P2P path — direct WebRTC DataChannel (Plan M)
    // ============================================================
    let pc: RTCPeerConnection | null = null;
    let dc: RTCDataChannel | null = null;
    let p2pOpenTimeout: ReturnType<typeof setTimeout> | null = null;
    let latencyPongInterval: ReturnType<typeof setInterval> | null = null;

    const closeP2P = (reason: string) => {
      if (p2pOpenTimeout) { clearTimeout(p2pOpenTimeout); p2pOpenTimeout = null; }
      if (latencyPongInterval) { clearInterval(latencyPongInterval); latencyPongInterval = null; }
      try { dc?.close(); } catch {}
      try { pc?.close(); } catch {}
      dc = null;
      pc = null;
      // If we lose P2P, drop back to broker — receiver flips its presence and
      // the studio's broker effect will start sending frames again.
      if (transportRef.current === "p2p-video" || transportRef.current === "p2p-canvas") {
        setTransportSafe("broker");
      }
      // Tear down the MSTG track so we don't keep it alive holding a frame ref.
      if (trackWriter) {
        try { trackWriter.close(); } catch {}
        trackWriter = null;
      }
      trackGenerator = null;
      // Drop the H.264 decoder so a fresh broker stream's keyframe re-inits it.
      try { videoDecoder?.close(); } catch {}
      videoDecoder = null;
      decoderConfigured = false;
      console.log("[p2p] receiver closed —", reason);
    };

    const handleP2PMessage = (data: ArrayBuffer) => {
      const frame = decodeBinaryFrame(data);
      if (!frame) return;
      lastFrameRef.current = Date.now();
      setReceiving(true);
      // Resolution change mid-stream → reset decoder; the keyframe carrying
      // this size will also carry a fresh `config` so we re-init below.
      if (decoderConfigured && (frame.width !== decoderW || frame.height !== decoderH)) {
        resetDecoderForResize();
      }
      if (!videoDecoder) {
        if (frame.config) setupDecoder(frame.config, true, frame.width, frame.height);
        else return; // wait for the first keyframe with config
      } else if (frame.config && !decoderConfigured) {
        setupDecoder(frame.config, true, frame.width, frame.height);
      }
      if (!videoDecoder) return;
      try {
        const chunk = new EncodedVideoChunk({
          type: (frame.flags & FLAG_KEYFRAME) ? "key" : "delta",
          timestamp: frame.ts * 1000,
          data: frame.data,
        });
        videoDecoder.decode(chunk);
      } catch (err) {
        console.warn("[p2p] decode failed", err);
      }
    };

    const handleSignaling = async (msg: any, senderId: string) => {
      if (!msg || msg.to !== viewerId) return;
      if (msg.kind === "offer" && msg.from === senderId) {
        try {
          if (!pc) {
            pc = new RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS });
            pc.onicecandidate = (e) => {
              if (e.candidate) {
                void channel.send({
                  type: "broadcast",
                  event: "p2p-signal",
                  payload: {
                    kind: "ice",
                    candidate: e.candidate.toJSON(),
                    from: viewerId,
                    to: senderId,
                  },
                });
              }
            };
            pc.onconnectionstatechange = () => {
              if (!pc) return;
              if (pc.connectionState === "failed" || pc.connectionState === "closed") {
                closeP2P(`pc-${pc.connectionState}`);
              }
            };
            pc.ondatachannel = (e) => {
              dc = e.channel;
              dc.binaryType = "arraybuffer";
              dc.onopen = () => {
                if (p2pOpenTimeout) { clearTimeout(p2pOpenTimeout); p2pOpenTimeout = null; }
                console.log("[p2p] receiver dc open");
                setTransportSafe(useTrackGenerator ? "p2p-video" : "p2p-canvas");
                // Echo latency every 1s.
                latencyPongInterval = setInterval(() => {
                  if (dc?.readyState === "open") {
                    try {
                      dc.send(JSON.stringify({
                        kind: "latency-pong",
                        sentTs: performance.now(),
                      }));
                    } catch {}
                  }
                }, 1000);
              };
              dc.onmessage = (ev) => {
                if (ev.data instanceof ArrayBuffer) handleP2PMessage(ev.data);
                // (we don't expect any other receiver-bound messages)
              };
              dc.onclose = () => closeP2P("dc-close");
              dc.onerror = (err) => console.warn("[p2p] dc error", err);
            };
          }
          await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await channel.send({
            type: "broadcast",
            event: "p2p-signal",
            payload: {
              kind: "answer",
              sdp: answer.sdp,
              from: viewerId,
              to: senderId,
            },
          });
        } catch (err) {
          console.warn("[p2p] answer failed", err);
          closeP2P("answer-failed");
        }
      } else if (msg.kind === "ice" && pc) {
        try { await pc.addIceCandidate(msg.candidate); } catch {}
      }
    };

    if (!forceBroker) {
      channel.on("broadcast", { event: "p2p-signal" }, (msg) => {
        const p = msg.payload as any;
        if (!p?.from) return;
        void handleSignaling(p, p.from);
      });
    }

    channel.subscribe(async (s) => {
      if (s === "SUBSCRIBED") {
        setStatus("waiting for stream");
        // Advertise capability: H.264 decode + (if not forced off) P2P.
        await channel.track({
          joined_at: Date.now(),
          role: "viewer",
          h264: canDecodeH264,
          p2p: !forceBroker,
          viewerId,
        });
        // If P2P doesn't open in 3 s, give up and stay on broker.
        if (!forceBroker) {
          p2pOpenTimeout = setTimeout(() => {
            if (transportRef.current !== "p2p-video" && transportRef.current !== "p2p-canvas") {
              console.warn("[p2p] open timeout — staying on broker");
              closeP2P("open-timeout");
              // Re-track without p2p so the studio stops trying.
              void channel.track({
                joined_at: Date.now(),
                role: "viewer",
                h264: canDecodeH264,
                p2p: false,
                viewerId,
              });
            }
          }, 3000);
        }
      } else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT") {
        setStatus("connection error");
      }
    });

    // Stall watchdog. P2P can recover faster than broker.
    const stallCheck = setInterval(() => {
      const t = transportRef.current;
      const stallMs = t === "p2p-video" || t === "p2p-canvas" ? 800 : 3000;
      if (lastFrameRef.current && Date.now() - lastFrameRef.current > stallMs) {
        setReceiving(false);
        setStatus("waiting for stream");
      }
    }, 500);

    return () => {
      clearInterval(stallCheck);
      jpegLatest = null;
      try { latestFrame?.close(); } catch {}
      latestFrame = null;
      try { videoDecoder?.close(); } catch {}
      videoDecoder = null;
      closeP2P("unmount");
      channel.untrack().catch(() => {});
      supabase.removeChannel(channel);
    };
  }, [apiKey, lowLatency, forceBroker]);

  // Show the <video> element when MSTG is feeding it; otherwise show the canvas.
  const showVideo = transport === "p2p-video";

  return (
    <div
      className="w-screen h-screen flex items-center justify-center overflow-hidden"
      style={{ background: transparent ? "transparent" : "#000" }}
    >
      <Helmet>
        <title>EliteSwap OBS Output Stream</title>
        <meta name="description" content="EliteSwap OBS browser source output — receives the realtime face-swap video stream from the studio." />
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>
      <h1 className="sr-only">EliteSwap OBS browser-source output</h1>
      {!receiving && (

        <p className="text-white/50 text-sm font-mono animate-pulse">
          {status === "missing key"
            ? "Missing unique key in URL (?key=...)"
            : status === "connection error"
            ? "Connection error — check your network."
            : "Waiting for studio stream… Open the studio in another tab."}
        </p>
      )}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        // N6: prevent Chromium from spinning up Picture-in-Picture or remote
        // playback machinery for the OBS video — both add a small amount of
        // processing per frame and serve no purpose for an OBS Browser Source.
        disablePictureInPicture
        disableRemotePlayback
        className={`w-full h-full object-contain ${receiving && showVideo ? "" : "hidden"}`}
      />
      <canvas
        ref={canvasRef}
        className={`w-full h-full object-contain ${receiving && !showVideo ? "" : "hidden"}`}
      />
    </div>
  );
}
