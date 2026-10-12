import { useRef, useState, useCallback, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

// aliyun-rtc-sdk is NOT statically imported here on purpose: it pulls in a
// ~1MB dependency tree (axios, aliyun-queen-engine, crypto-js, etc.) that a
// static import inlines into whatever chunk DeepfakeStudio.tsx ends up in --
// confirmed by a real build: the main bundle jumped from 258KB to 1.3MB
// before this was switched to a dynamic import. Since active_provider
// defaults to 'decart' and only an admin can flip it, almost no visitor
// should ever pay for this download; loading it lazily inside connect()
// means they don't, while Decart's existing bundling (its own SDK already
// splits into a separate livekit-client chunk) stays untouched.
let aliRtcModulePromise: Promise<typeof import("aliyun-rtc-sdk")> | null = null;
function loadAliRtc() {
  if (!aliRtcModulePromise) aliRtcModulePromise = import("aliyun-rtc-sdk");
  return aliRtcModulePromise;
}

export type ViduConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

export interface ViduConnectParams {
  pKey: string;
  sessionId: string;
  /** data:image/...;base64,... -- Vidu's external image_url fetch path is
   * confirmed broken server-side (reproduced across 2 keys, every image and
   * editing_type tried); inline base64 is the only path confirmed working. */
  referenceImageDataUri: string;
  editingType?: string;
  onRemoteStream: (stream: MediaStream) => void;
}

// Everything in this module is hands-on confirmed against a live Vidu
// account and the real aliyun-rtc-sdk@7.3.x TypeScript definitions (not
// doc-skimmed) -- EXCEPT the actual browser-side joinChannel/subscribe flow
// below, which has not yet been run in a real browser. Treat the mint
// request/response shape as solid; treat the AliRTC wiring as a careful
// first pass that needs a real end-to-end connect test before wide rollout.
//
// Key confirmed facts this hook relies on:
// - mint-vidu-rtc-session (supabase/functions/mint-vidu-rtc-session) returns
//   { rtc: { app_id, channel_id, user_id, token, token_expire_at, provider },
//     render_uid, live_id, client_secret }.
// - rtc.token is NOT a plain AliRTC token string -- it's a base64-encoded
//   JSON blob: { appid, channelid, nonce, timestamp, token, userid }. This
//   is literally the AliRtcAuthInfo payload, just bundled and base64-wrapped
//   by Vidu. Decoded and remapped to the SDK's camelCase AliRtcAuthInfo
//   shape (appId/channelId/userId/nonce/timestamp/token) below.
// - render_uid is a SEPARATE identity from rtc.user_id: rtc.user_id is this
//   browser's own publish identity; render_uid is the identity the
//   AI-transformed output is published under. We join as rtc.user_id and
//   wait for render_uid's track to become available, mirroring Decart's
//   onRemoteStream callback pattern.
// - aliyun-rtc-sdk's AliRtcEngine.getVideoTrack({ userId, streamType }) and
//   getAudioTrack(userId) return raw MediaStreamTrack objects for ANY uid
//   (local when userId is omitted, remote when provided) -- confirmed via
//   the package's shipped .d.ts. Wrapping those in `new MediaStream([...])`
//   gives the same MediaStream shape useDecartRealtime's onRemoteStream
//   callback already expects, so DeepfakeStudio.tsx doesn't need a
//   provider-specific rendering path downstream of connect().

const JOIN_TIMEOUT_MS = 20000;
const PREVIEW_TIMEOUT_MS = 10000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

// A timed-out startPreview()/joinChannel() doesn't actually cancel the
// underlying getUserMedia() call -- the browser can still grab the camera
// in the background afterward, orphaned, with nothing left to release it,
// since we gave up our only reference when we stopped waiting. Explicitly
// stopping whatever local video track exists (MediaStreamTrack.stop() works
// regardless of what acquired it) before destroying the engine is the best
// defense available against that without a confirmed cancellation API.
async function releaseEngine(engine: any) {
  if (!engine) return;
  try {
    const { AliRtcRawDataStreamType } = await loadAliRtc();
    const localTrack = await engine.getVideoTrack({ streamType: AliRtcRawDataStreamType.AliRtcSdkStreamTypeCapture }).catch(() => undefined);
    localTrack?.stop?.();
  } catch { /* noop */ }
  try { await engine.enableLocalVideo?.(false); } catch { /* noop */ }
  try { await engine.leaveChannel?.(); } catch { /* noop */ }
  try { await engine.destroy?.(); } catch { /* noop */ }
}

function buildControlSocketUrl(params: { accessToken: string; pKey: string; sessionId: string; liveId: string; clientSecret?: string | null }) {
  const base = import.meta.env.VITE_SUPABASE_URL as string;
  const wsBase = base.replace(/^http/, "ws");
  const query = new URLSearchParams({
    access_token: params.accessToken,
    p_key: params.pKey,
    p_session_id: params.sessionId,
    live_id: params.liveId,
  });
  if (params.clientSecret) query.set("client_secret", params.clientSecret);
  return `${wsBase}/functions/v1/vidu-control-relay?${query.toString()}`;
}

export function useViduRealtime() {
  const [connectionState, setConnectionState] = useState<ViduConnectionState>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const engineRef = useRef<any>(null);
  const renderUidRef = useRef<string | null>(null);
  const onRemoteStreamRef = useRef<((s: MediaStream) => void) | null>(null);
  const remoteDeliveredRef = useRef(false);
  const controlSocketRef = useRef<WebSocket | null>(null);

  const tryDeliverRemoteStream = useCallback(async () => {
    const engine = engineRef.current;
    const renderUid = renderUidRef.current;
    if (!engine || !renderUid || remoteDeliveredRef.current) return;
    try {
      const { AliRtcRawDataStreamType } = await loadAliRtc();
      const videoTrack = await engine.getVideoTrack({
        userId: renderUid,
        streamType: AliRtcRawDataStreamType.AliRtcSdkStreamTypeCapture,
      });
      if (!videoTrack) return; // not published yet; a later event will retry
      const audioTrack = await engine.getAudioTrack(renderUid).catch(() => undefined);
      const tracks: MediaStreamTrack[] = [videoTrack];
      if (audioTrack) tracks.push(audioTrack);
      remoteDeliveredRef.current = true;
      onRemoteStreamRef.current?.(new MediaStream(tracks));
      setConnectionState("connected");
    } catch (err) {
      console.warn("[useViduRealtime] Failed to materialize the remote stream", err);
    }
  }, []);

  const connect = useCallback(async (params: ViduConnectParams) => {
    const { pKey, sessionId, referenceImageDataUri, editingType, onRemoteStream } = params;
    setConnectionState("connecting");
    setError(null);
    remoteDeliveredRef.current = false;
    onRemoteStreamRef.current = onRemoteStream;

    try {
      const { data: session, error: sessionErr } = await supabase.functions.invoke("mint-vidu-rtc-session", {
        body: {
          p_key: pKey,
          p_session_id: sessionId,
          image_url: referenceImageDataUri,
          editing_type: editingType,
        },
      });
      if (sessionErr) throw new Error(sessionErr.message || "Could not start the Vidu session");
      if (!session?.ok) throw new Error(session?.message || "Vidu rejected the session request");

      const rtc = session.rtc;
      renderUidRef.current = session.render_uid || null;
      if (!rtc?.token) throw new Error("Vidu did not return join credentials");

      // Separate from the AliRTC media join below: Vidu's sessions come
      // back in "waiting" status and (per their own reference server) need
      // this control WebSocket's conn_init handshake completed before they
      // start actually producing output. Opened in parallel with the media
      // join since it only needs live_id/client_secret, both already in
      // hand -- doesn't need to wait for joinChannel to resolve first.
      // Best-effort: failure here shouldn't block the media connection
      // itself, since the camera panel is useful even if this fails and
      // gets caught/retried separately. Logged loudly either way.
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const accessToken = sessionData?.session?.access_token;
        if (accessToken && session.live_id) {
          const controlUrl = buildControlSocketUrl({
            accessToken,
            pKey,
            sessionId,
            liveId: session.live_id,
            clientSecret: session.client_secret,
          });
          const controlSocket = new WebSocket(controlUrl);
          controlSocketRef.current = controlSocket;
          controlSocket.onmessage = (ev) => {
            try {
              const msg = JSON.parse(ev.data);
              if (msg?.payload?.conn_init_ack) {
                if (msg.payload.conn_init_ack.success) {
                  console.info("[useViduRealtime] control channel ready (conn_init_ack success)");
                } else {
                  console.warn("[useViduRealtime] control channel conn_init_ack failed", msg.payload.conn_init_ack);
                }
              } else if (msg?.event === "fatal") {
                console.error("[useViduRealtime] control channel fatal", msg);
              } else {
                console.info("[useViduRealtime] control channel message", msg);
              }
            } catch {
              console.info("[useViduRealtime] control channel raw message", ev.data);
            }
          };
          controlSocket.onerror = (ev) => console.error("[useViduRealtime] control channel error", ev);
          controlSocket.onclose = (ev) => console.info("[useViduRealtime] control channel closed", ev.code, ev.reason);
        } else {
          console.warn("[useViduRealtime] could not open control channel: missing access token or live_id");
        }
      } catch (controlErr) {
        console.error("[useViduRealtime] control channel setup failed", controlErr);
      }

      let authInfo: { appId: string; channelId: string; userId: string; nonce?: string; timestamp: number; token: string };
      try {
        const decoded = JSON.parse(atob(rtc.token));
        authInfo = {
          appId: decoded.appid,
          channelId: decoded.channelid,
          userId: decoded.userid,
          nonce: decoded.nonce || undefined,
          timestamp: decoded.timestamp,
          token: decoded.token,
        };
        if (!authInfo.appId || !authInfo.channelId || !authInfo.userId || !authInfo.token) {
          throw new Error("incomplete");
        }
      } catch {
        throw new Error("Could not read Vidu session credentials");
      }

      const { default: AliRtcEngine } = await loadAliRtc();
      // createInstance(), not getInstance(): getInstance() is a singleton
      // getter -- if a previous failed attempt left its engine in a wedged
      // internal state (plausible given the camera issues seen so far),
      // every subsequent attempt would silently inherit that same broken
      // instance instead of starting clean. createInstance() guarantees a
      // genuinely fresh engine every connect.
      const engine = AliRtcEngine.createInstance();
      engineRef.current = engine;

      engine.on("remoteUserOnLineNotify", (uid: string) => {
        if (uid === renderUidRef.current) void tryDeliverRemoteStream();
      });
      engine.on("remoteTrackAvailableNotify", (uid: string) => {
        if (uid === renderUidRef.current) void tryDeliverRemoteStream();
      });
      engine.on("occurError", (err: any) => {
        console.error("[useViduRealtime] engine error", err);
        setError(err?.message || "Vidu connection error");
      });

      // NOTE: an explicit enableLocalVideo(true) call was tried here and
      // reverted -- live testing showed it reintroduced the exact
      // stuck-on-connecting hang that the startPreview() timeout below was
      // added to fix, right after a round where the connection was
      // actually getting through (camera permission granted) without it.
      // Likely conflicts with startPreview()'s own internal camera
      // handling rather than helping it. Do not re-add without confirming
      // it's actually necessary first.

      // Starting the local preview before joinChannel opens the camera; the
      // engine auto-publishes camera+mic on join (its documented default),
      // so no separate publish() call is needed on this SDK version.
      // Timeout-guarded: an unresolved startPreview() (e.g. camera access
      // silently stuck) previously left connectionState stuck on
      // "connecting" forever with no error, since nothing downstream of it
      // could ever run -- reproduced live.
      try {
        await withTimeout(engine.startPreview(), PREVIEW_TIMEOUT_MS, "Could not access your camera. Check camera permissions and try again.");
      } catch (previewErr) {
        console.error("[useViduRealtime] startPreview failed", previewErr);
        throw previewErr;
      }

      await withTimeout(engine.joinChannel(authInfo, "eliteswap-user"), JOIN_TIMEOUT_MS, "Connection timed out");

      // The remote (AI-transformed) track may already be publishing by the
      // time join resolves; the event listeners above catch it otherwise.
      void tryDeliverRemoteStream();

      // DeepfakeStudio.tsx's own camera-feed panel expects a local
      // MediaStream back from connect() (mirrors Decart's connect(), which
      // returns { stream, realtimeClient } for exactly this) -- this was
      // missing entirely before, so that panel had nothing to show even
      // when the camera and connection were otherwise fine.
      const { AliRtcRawDataStreamType } = await loadAliRtc();
      const localVideoTrack = await engine.getVideoTrack({ streamType: AliRtcRawDataStreamType.AliRtcSdkStreamTypeCapture }).catch(() => undefined);
      const localAudioTrack = await engine.getAudioTrack().catch(() => undefined);
      const localTracks: MediaStreamTrack[] = [];
      if (localVideoTrack) localTracks.push(localVideoTrack);
      if (localAudioTrack) localTracks.push(localAudioTrack);
      const localStream = localTracks.length > 0 ? new MediaStream(localTracks) : null;
      if (!localStream) {
        console.warn("[useViduRealtime] joined successfully but no local track was available to return");
      }

      return { engine, liveId: session.live_id as string | null, stream: localStream };
    } catch (err: any) {
      const message = err?.message || "Failed to connect to Vidu realtime";
      setError(message);
      await releaseEngine(engineRef.current);
      engineRef.current = null;
      try { controlSocketRef.current?.close(); } catch { /* noop */ }
      controlSocketRef.current = null;
      setConnectionState("disconnected");
      throw err;
    }
  }, [tryDeliverRemoteStream]);

  const disconnect = useCallback(async () => {
    await releaseEngine(engineRef.current);
    engineRef.current = null;
    try { controlSocketRef.current?.close(); } catch { /* noop */ }
    controlSocketRef.current = null;
    renderUidRef.current = null;
    remoteDeliveredRef.current = false;
    onRemoteStreamRef.current = null;
    setConnectionState("disconnected");
  }, []);

  useEffect(() => {
    return () => {
      void releaseEngine(engineRef.current);
      try { controlSocketRef.current?.close(); } catch { /* noop */ }
    };
  }, []);

  return {
    connectionState,
    error,
    connect,
    disconnect,
  };
}
