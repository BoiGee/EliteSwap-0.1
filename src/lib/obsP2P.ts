// OBS peer-to-peer transport helpers.
//
// Binary wire format (little-endian, ArrayBuffer over RTCDataChannel):
//
//   byte 0       flags  (bit0 = keyframe, bit1 = has decoder config)
//   bytes 1-4    ts     (uint32, ms since session start)
//   bytes 5-6    width  (uint16, pixels)
//   bytes 7-8    height (uint16, pixels)
//   bytes 9-10   configLen (uint16) — present only if flags & 0x02
//   [configLen]  decoderConfig (avcC bytes) — present only if flags & 0x02
//   [...]        H.264 encoded chunk bytes
//
// 9-byte fixed header (or 11 + configLen on keyframes with config). Compare
// to the previous JSON+base64 envelope which spent ~50 bytes on field names
// and inflated the chunk by 33%. Net wire savings on talking-head scenes
// (~1 KB chunks) are ~30%, plus the chunk itself is sent raw.

export const FLAG_KEYFRAME = 0x01;
export const FLAG_HAS_CONFIG = 0x02;

export interface BinaryFrame {
  flags: number;
  ts: number;
  width: number;
  height: number;
  config?: Uint8Array;
  data: Uint8Array;
}

export const encodeBinaryFrame = (frame: BinaryFrame): ArrayBuffer => {
  const cfgLen = frame.config?.byteLength ?? 0;
  const headerLen = 9 + (cfgLen > 0 ? 2 + cfgLen : 0);
  const buf = new ArrayBuffer(headerLen + frame.data.byteLength);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  let flags = frame.flags;
  if (cfgLen > 0) flags |= FLAG_HAS_CONFIG;

  view.setUint8(0, flags);
  view.setUint32(1, frame.ts >>> 0, true);
  view.setUint16(5, frame.width, true);
  view.setUint16(7, frame.height, true);

  let offset = 9;
  if (cfgLen > 0 && frame.config) {
    view.setUint16(offset, cfgLen, true);
    offset += 2;
    u8.set(frame.config, offset);
    offset += cfgLen;
  }
  u8.set(frame.data, offset);
  return buf;
};

export const decodeBinaryFrame = (buf: ArrayBuffer): BinaryFrame | null => {
  if (buf.byteLength < 9) return null;
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const flags = view.getUint8(0);
  const ts = view.getUint32(1, true);
  const width = view.getUint16(5, true);
  const height = view.getUint16(7, true);

  let offset = 9;
  let config: Uint8Array | undefined;
  if (flags & FLAG_HAS_CONFIG) {
    if (buf.byteLength < offset + 2) return null;
    const cfgLen = view.getUint16(offset, true);
    offset += 2;
    if (buf.byteLength < offset + cfgLen) return null;
    config = u8.slice(offset, offset + cfgLen);
    offset += cfgLen;
  }
  const data = u8.slice(offset);
  return { flags, ts, width, height, config, data };
};

// ---- Signaling messages over Supabase Realtime (small JSON, infrequent) ----
export type SignalingMsg =
  | { kind: "offer"; sdp: string; from: string; to: string }
  | { kind: "answer"; sdp: string; from: string; to: string }
  | { kind: "ice"; candidate: RTCIceCandidateInit; from: string; to: string }
  // Echoed by the receiver once per second so the sender can compute true
  // glass-to-glass latency. Encoded as JSON over signaling (cheap, infrequent).
  | { kind: "latency-pong"; sentTs: number; from: string; to: string };

// Default to Google's free public STUN. Plenty for same-LAN and most
// home-router NATs. Symmetric NATs / strict corporate firewalls will fail
// to negotiate and fall back to the broker path.
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

// Picks a stable per-tab id so signaling messages can be addressed.
export const newPeerId = () => `p-${Math.random().toString(36).slice(2, 10)}`;

// Whether this browser can use the receiver-side fast-path: feed decoded
// VideoFrames straight into a MediaStream backed by the GPU compositor.
// Chromium-only as of writing; Safari/Firefox use the canvas fallback.
export const canUseTrackGenerator = (): boolean =>
  typeof (globalThis as any).MediaStreamTrackGenerator === "function";

// Whether this browser can encode/decode H.264 via WebCodecs.
export const canUseWebCodecs = (kind: "encoder" | "decoder"): boolean => {
  const klass = kind === "encoder" ? "VideoEncoder" : "VideoDecoder";
  return typeof (globalThis as any)[klass] === "function";
};
