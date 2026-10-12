import { useRef, useState, useCallback, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

// Lazy-loaded: the SDK is ~1MB and a static import lands it in the main bundle.
let aliRtcModulePromise: Promise<typeof import("aliyun-rtc-sdk")> | null = null;
function loadAliRtc() {
  if (!aliRtcModulePromise) aliRtcModulePromise = import("aliyun-rtc-sdk");
  return aliRtcModulePromise;
}

export type ViduConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

export interface ViduConnectParams {
  pKey: string;
  sessionId: string;
  /** data:image/...;base64 -- Vidu's external image_url fetch is broken server-side. */
  referenceImageDataUri: string;
  editingType?: string;
  onRemoteStream: (stream: MediaStream) => void;
  /** Vidu ended the session on its side (render worker left, server hangup, control lost, no output). */
  onEnded?: (reason: string) => void;
}

// Verified end-to-end against the live service (headless Chrome + fake camera):
// - Without conn_init on the control channel, Vidu's render worker leaves ~25s in and output freezes.
// - render_uid's track is only retrievable once its subscription reaches Subscribed, after join resolves.
// - The SDK auto-plays subscribed remote audio; nothing consumes output audio, so it would only echo.
const PREVIEW_TIMEOUT_MS = 30000; // covers a camera-permission prompt the user still has to answer
const JOIN_TIMEOUT_MS = 30000; // measured 2-5s
const OUTPUT_TIMEOUT_MS = 45000; // swapped output measured arriving 7-9s after join starts
const REMOTE_POLL_MS = 1000;
const CONTROL_RECONNECT_DELAYS_MS = [500, 1500, 3000, 5000];
const DEFAULT_CONTROL_URL = "wss://api.vidu.com/live/ws/live/connect";
const USER_OFFLINE_QUIT = 0; // AliRtcUserOfflineReason.AliRtcUserOfflineQuit (not exported at runtime)

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

// A timed-out getUserMedia() isn't cancelled; stop the track or the camera stays locked.
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

// Opened directly from the browser: the per-session client_secret authenticates it, no API key.
// Envelope per Vidu's reference server: type 1 conn_init, 2 ack, 5 hangup (client), 6 hangup (server).
class ViduControlChannel {
  private ws: WebSocket | null = null;
  private seq = 0;
  private connId = "";
  private attempts = 0;
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly liveId: string,
    private readonly clientSecret: string,
    private readonly onEnded: (reason: string) => void,
  ) {}

  open() {
    if (this.closed) return;
    this.connId = crypto.randomUUID();
    this.seq = 0;
    const query = new URLSearchParams({ live_id: this.liveId, conn_id: this.connId, client_secret: this.clientSecret });
    const ws = new WebSocket(`${this.url}?${query.toString()}`);
    this.ws = ws;
    ws.onopen = () => this.send(1, { conn_init: { version: 1 } });
    ws.onmessage = (ev) => this.handleMessage(ev.data);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closed) return;
      // The render worker leaves ~25s after losing this channel; a new conn_id + conn_init re-attaches.
      const delay = CONTROL_RECONNECT_DELAYS_MS[this.attempts];
      if (delay === undefined) {
        this.end("control_lost");
        return;
      }
      this.attempts++;
      console.warn(`[useViduRealtime] control channel dropped; reconnecting in ${delay}ms`);
      setTimeout(() => this.open(), delay);
    };
  }

  hangup() {
    if (this.closed) return;
    this.closed = true;
    this.send(5, { hangup: { hangup_reason: "user_end" } });
    const ws = this.ws;
    this.ws = null;
    setTimeout(() => { try { ws?.close(1000, "session ended"); } catch { /* noop */ } }, 300);
  }

  private send(type: number, payload: Record<string, unknown>) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type, live_id: this.liveId, conn_id: this.connId, seq_id: ++this.seq, payload }));
  }

  private handleMessage(data: unknown) {
    let msg: any;
    try { msg = JSON.parse(String(data)); } catch { return; }
    const ack = msg?.payload?.conn_init_ack;
    if (ack) {
      if (ack.success) {
        this.attempts = 0;
        console.info("[useViduRealtime] control channel ready");
      } else if (ack.error_code !== "NOT_READY") {
        // NOT_READY is transient for editing sessions; anything else (e.g. LIVE_ENDED) is final.
        console.error("[useViduRealtime] control channel rejected", ack);
        this.end(`control_rejected:${ack.error_code || "unknown"}`);
      }
      return;
    }
    if (msg?.type === 6) this.end(msg.payload?.hangup?.hangup_reason || "server_hangup");
  }

  private end(reason: string) {
    if (this.closed) return;
    this.closed = true;
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* noop */ }
    this.onEnded(reason);
  }
}

export function useViduRealtime() {
  const [connectionState, setConnectionState] = useState<ViduConnectionState>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const engineRef = useRef<any>(null);
  const controlRef = useRef<ViduControlChannel | null>(null);
  const renderUidRef = useRef<string | null>(null);
  const onRemoteStreamRef = useRef<((s: MediaStream) => void) | null>(null);
  const onEndedRef = useRef<((reason: string) => void) | null>(null);
  const deliveredTrackRef = useRef<MediaStreamTrack | null>(null);
  const remotePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const outputWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endingRef = useRef(false);

  const stopTimers = useCallback(() => {
    if (remotePollRef.current) { clearInterval(remotePollRef.current); remotePollRef.current = null; }
    if (outputWatchdogRef.current) { clearTimeout(outputWatchdogRef.current); outputWatchdogRef.current = null; }
  }, []);

  const handleEnded = useCallback((reason: string) => {
    if (endingRef.current) return;
    endingRef.current = true;
    console.warn("[useViduRealtime] session ended by Vidu:", reason);
    stopTimers();
    controlRef.current?.hangup();
    controlRef.current = null;
    void releaseEngine(engineRef.current);
    engineRef.current = null;
    setError(reason === "no_output" ? "Vidu didn't start sending the swapped video" : "The Vidu session ended");
    setConnectionState("disconnected");
    const onEnded = onEndedRef.current;
    onEndedRef.current = null;
    onEnded?.(reason);
  }, [stopTimers]);

  const tryDeliverRemoteStream = useCallback(async () => {
    const engine = engineRef.current;
    const renderUid = renderUidRef.current;
    if (!engine || !renderUid || endingRef.current) return;
    try {
      const { AliRtcRawDataStreamType } = await loadAliRtc();
      const videoTrack: MediaStreamTrack | undefined = await engine.getVideoTrack({
        userId: renderUid,
        streamType: AliRtcRawDataStreamType.AliRtcSdkStreamTypeCapture,
      });
      if (!videoTrack || endingRef.current) return;
      stopTimers();
      // A re-subscription hands back a new track object; re-deliver so output isn't left on a dead one.
      if (videoTrack === deliveredTrackRef.current) return;
      deliveredTrackRef.current = videoTrack;
      onRemoteStreamRef.current?.(new MediaStream([videoTrack]));
      setConnectionState("connected");
    } catch (err) {
      console.warn("[useViduRealtime] Failed to materialize the remote stream", err);
    }
  }, [stopTimers]);

  const connect = useCallback(async (params: ViduConnectParams) => {
    const { pKey, sessionId, referenceImageDataUri, editingType, onRemoteStream, onEnded } = params;
    endingRef.current = false;
    setConnectionState("connecting");
    setError(null);
    deliveredTrackRef.current = null;
    onRemoteStreamRef.current = onRemoteStream;
    // Armed only once connect() succeeds; an end before that surfaces as connect()'s own error.
    onEndedRef.current = null;

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
      if (!rtc?.token || !renderUidRef.current) throw new Error("Vidu did not return join credentials");
      if (!session.live_id || !session.client_secret) throw new Error("Vidu did not return session control credentials");

      const control = new ViduControlChannel(session.control_url || DEFAULT_CONTROL_URL, session.live_id, session.client_secret, handleEnded);
      controlRef.current = control;
      control.open();

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

      const AliRtc = await loadAliRtc();
      // createInstance(), not the getInstance() singleton, so a wedged engine from a failed attempt can't leak in.
      const engine = AliRtc.default.createInstance();
      engineRef.current = engine;

      const isRender = (uid: string) => uid === renderUidRef.current;
      engine.on("remoteUserOnLineNotify", (uid: string) => { if (isRender(uid)) void tryDeliverRemoteStream(); });
      engine.on("remoteTrackAvailableNotify", (uid: string) => { if (isRender(uid)) void tryDeliverRemoteStream(); });
      engine.on("videoSubscribeStateChanged", (uid: string, _prev: number, next: number) => {
        if (isRender(uid) && next === AliRtc.AliRtcSubscribeState.AliRtcStateSubscribed) void tryDeliverRemoteStream();
      });
      engine.on("remoteUserOffLineNotify", (uid: string, reason: number) => {
        if (isRender(uid) && reason === USER_OFFLINE_QUIT && deliveredTrackRef.current) handleEnded("render_left");
      });
      engine.on("connectionStatusChange", (status: number) => {
        if (status === AliRtc.AliRtcConnectionStatus.AliRtcConnectionStatusFailed) handleEnded("connection_failed");
      });
      engine.on("occurError", (err: any) => {
        console.error("[useViduRealtime] engine error", err);
        setError(err?.message || "Vidu connection error");
      });

      engine.setDefaultSubscribeAllRemoteAudioStreams(false);

      // Don't add enableLocalVideo(true) here: it reintroduced a stuck-on-connecting hang in live testing.
      try {
        await withTimeout(engine.startPreview(), PREVIEW_TIMEOUT_MS, "Could not access your camera. Check camera permissions and try again.");
      } catch (previewErr) {
        console.error("[useViduRealtime] startPreview failed", previewErr);
        throw previewErr;
      }

      await withTimeout(engine.joinChannel(authInfo, "eliteswap-user"), JOIN_TIMEOUT_MS, "Connection timed out");

      void tryDeliverRemoteStream();
      if (!deliveredTrackRef.current) {
        remotePollRef.current = setInterval(() => void tryDeliverRemoteStream(), REMOTE_POLL_MS);
        outputWatchdogRef.current = setTimeout(() => {
          if (!deliveredTrackRef.current) handleEnded("no_output");
        }, OUTPUT_TIMEOUT_MS);
      }

      // DeepfakeStudio's camera panel expects the local stream back, like Decart's connect().
      const localVideoTrack = await engine.getVideoTrack({ streamType: AliRtc.AliRtcRawDataStreamType.AliRtcSdkStreamTypeCapture }).catch(() => undefined);
      const localAudioTrack = await engine.getAudioTrack().catch(() => undefined);
      const localTracks: MediaStreamTrack[] = [];
      if (localVideoTrack) localTracks.push(localVideoTrack);
      if (localAudioTrack) localTracks.push(localAudioTrack);
      const localStream = localTracks.length > 0 ? new MediaStream(localTracks) : null;
      if (!localStream) {
        console.warn("[useViduRealtime] joined successfully but no local track was available to return");
      }

      if (endingRef.current) throw new Error("The Vidu session ended before it finished connecting");
      onEndedRef.current = onEnded ?? null;
      return { engine, liveId: session.live_id as string, stream: localStream };
    } catch (err: any) {
      endingRef.current = true;
      stopTimers();
      controlRef.current?.hangup();
      controlRef.current = null;
      await releaseEngine(engineRef.current);
      engineRef.current = null;
      setError(err?.message || "Failed to connect to Vidu realtime");
      setConnectionState("disconnected");
      throw err;
    }
  }, [handleEnded, stopTimers, tryDeliverRemoteStream]);

  const disconnect = useCallback(async () => {
    endingRef.current = true;
    stopTimers();
    controlRef.current?.hangup();
    controlRef.current = null;
    await releaseEngine(engineRef.current);
    engineRef.current = null;
    renderUidRef.current = null;
    deliveredTrackRef.current = null;
    onRemoteStreamRef.current = null;
    onEndedRef.current = null;
    setConnectionState("disconnected");
  }, [stopTimers]);

  useEffect(() => {
    const onPageHide = () => controlRef.current?.hangup();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      endingRef.current = true;
      if (remotePollRef.current) clearInterval(remotePollRef.current);
      if (outputWatchdogRef.current) clearTimeout(outputWatchdogRef.current);
      controlRef.current?.hangup();
      void releaseEngine(engineRef.current);
    };
  }, []);

  return {
    connectionState,
    error,
    connect,
    disconnect,
  };
}
