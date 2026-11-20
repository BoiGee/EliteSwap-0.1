import { useRef, useState, useCallback, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { brandMessage } from "@/lib/brandMessage";

// User-facing copy says "studio", never the provider's name (see brandMessage).
const CONNECT_FAILED = "Couldn't connect to the studio. Please try again.";
const SESSION_START_FAILED = "The studio couldn't start your session. Please try again.";

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
  /** "Go live": rtmp:// ingest URLs (server + stream key) Vidu relays the swapped output to. */
  rtmpUrls?: string[];
  /** Requested output resolution (540p/720p/1080p); the server caps it at the plan's ceiling. */
  resolution?: string;
  /** Phones: start on the rear camera. Omitted = the browser's default (front/webcam). */
  facing?: "front" | "rear";
  /**
   * Call mode (screen-sharing the swap into a WhatsApp/Telegram/Zoom call): never open the
   * microphone, so the calling app keeps it. The output then carries no audio.
   */
  cameraOnly?: boolean;
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
const RTMP_ADDRESS_COOLDOWN_MS = 12000;
const CAMERA_REAR = 0; // AliRtcCameraDirection.CAMERA_REAR (a type-only enum, not exported at runtime)

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

/** An error carrying the mint function's machine-readable code (e.g. VIDU_BUSY, RTMP_INVALID). */
export class ViduSessionError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = "ViduSessionError"; }
}

// supabase.functions.invoke() reports any non-2xx as a bare "Edge Function returned a non-2xx
// status code"; the function's own { code, message } body is on error.context (a Response).
async function mintViduSession(body: Record<string, unknown>, fallback: string) {
  const { data, error } = await supabase.functions.invoke("mint-vidu-rtc-session", { body });
  if (error) {
    let parsed: { code?: string; message?: string } | null = null;
    try { parsed = await (error as { context?: Response }).context?.json?.(); } catch { /* not JSON */ }
    throw new ViduSessionError(brandMessage(parsed?.message, fallback), parsed?.code || "MINT_FAILED");
  }
  if (!data?.ok) throw new ViduSessionError(brandMessage(data?.message, fallback), data?.code || "MINT_FAILED");
  return data;
}

/**
 * Whether this browser can run the live studio, checked BEFORE a studio session opens (a failed
 * start still costs the user a minimum charge). `blocked` only for hard failures (no WebRTC or
 * no H.264); the SDK's browser allow-list alone isn't trusted to block, since it may not know
 * newer or regional browsers that work fine.
 */
export async function checkViduBrowserSupport(): Promise<{ blocked: boolean; unlisted: boolean }> {
  try {
    const AliRtc = await loadAliRtc();
    const { detail } = await AliRtc.default.isSupported("sendrecv");
    const blocked = !detail.isWebRTCSupported || !detail.isH264EncodeSupported || !detail.isH264DecodeSupported;
    return { blocked, unlisted: !detail.isBrowserSupported };
  } catch {
    return { blocked: false, unlisted: false };
  }
}

/** User-facing text for why Vidu ended a session (hangup reasons, conn_init errors, our own). */
export function describeViduEnd(reason: string): string {
  const r = reason.toLowerCase();
  if (r === "no_output" || r === "start_failed") return "The swap didn't start. Please reconnect.";
  if (r === "relay_start_failed") return "The session stopped before your live stream started. Check the server URL and stream key under Go live, then reconnect. If they're right, switch Go live off to test the swap on its own.";
  if (/audit|violation|moderat/.test(r)) return "Our content check stopped this session. Use a different reference photo and keep the camera framing to one adult person.";
  if (/credit|balance/.test(r)) return "The studio is briefly at capacity. Please try again in a few minutes.";
  if (/rtmp|relay|push/.test(r)) return "Your live stream couldn't start: the streaming platform didn't accept the server URL or stream key. Check them under Go live, then reconnect.";
  if (/timeout|expired/.test(r) && !/reconnect|ready/.test(r)) return "The session reached its time limit. Reconnect to continue.";
  if (/not_ready|sip_ready|render/.test(r)) return "The swap service didn't get ready in time. Please reconnect.";
  if (/control_lost|connection_failed|reconnect/.test(r)) return "Your connection to the studio dropped. Check your network and reconnect.";
  return "The swap session ended unexpectedly. Reconnect to continue.";
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
// Envelope per Vidu's docs: type 1 conn_init, 2 ack, 5 hangup (client), 6 hangup (server),
// 13 switch_prompt (change reference image / editing_type mid-session), 14 switch failure.
// switch_prompt has no success ack, and Vidu doesn't dedupe it: never resend on silence.
const SWITCH_FAILURE_WINDOW_MS = 4000;
const NOT_READY_RETRY_MS = 1000;
const NOT_READY_MAX_RETRIES = 30;
const MAX_WS_FRAME_BYTES = 16 * 1024 * 1024;

type SwitchFailure = { error_code?: string; error_msg?: string };

// Our own failures (TOO_LARGE, NOT_CONNECTED) carry user-ready text; the provider's own type=14
// failures carry raw protocol text, so those get the branded fallback.
function switchFailureMessage(failure: SwitchFailure, fallback: string): string {
  const ours = failure.error_code === "TOO_LARGE" || failure.error_code === "NOT_CONNECTED";
  return ours ? brandMessage(failure.error_msg, fallback) : fallback;
}

class ViduControlChannel {
  private pendingSwitch: ((failure: SwitchFailure | null) => void) | null = null;
  private ws: WebSocket | null = null;
  private seq = 0;
  private connId = "";
  private attempts = 0;
  private notReadyRetries = 0;
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

  private send(type: number, payload: Record<string, unknown>): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ type, live_id: this.liveId, conn_id: this.connId, seq_id: ++this.seq, payload }));
    return true;
  }

  // Resolves null if Vidu raised no type=14 failure within the window (it sends nothing on success).
  switchPrompt(opts: { imageDataUri?: string; editingType?: string }): Promise<SwitchFailure | null> {
    const switchPrompt: Record<string, unknown> = {};
    if (opts.imageDataUri) switchPrompt.prompts = [{ type: "image", content: opts.imageDataUri }];
    if (opts.editingType) switchPrompt.editing_type = opts.editingType;
    if (opts.imageDataUri && opts.imageDataUri.length > MAX_WS_FRAME_BYTES - 1024) {
      return Promise.resolve({ error_code: "TOO_LARGE", error_msg: "The photo is too large to send. Use a smaller image." });
    }
    if (this.pendingSwitch) this.pendingSwitch(null);
    return new Promise((resolve) => {
      if (!this.send(13, { switch_prompt: switchPrompt })) {
        resolve({ error_code: "NOT_CONNECTED", error_msg: "The session's control connection isn't open right now." });
        return;
      }
      const timer = setTimeout(() => { this.pendingSwitch = null; resolve(null); }, SWITCH_FAILURE_WINDOW_MS);
      this.pendingSwitch = (failure) => { clearTimeout(timer); this.pendingSwitch = null; resolve(failure); };
    });
  }

  private handleMessage(data: unknown) {
    let msg: any;
    try { msg = JSON.parse(String(data)); } catch { return; }
    const ack = msg?.payload?.conn_init_ack;
    if (ack) {
      if (ack.success) {
        this.attempts = 0;
        this.notReadyRetries = 0;
        console.info("[useViduRealtime] control channel ready");
      } else if (ack.error_code === "NOT_READY") {
        // Per Vidu's docs: resend conn_init after a short wait. Vidu caps the retries on its side
        // and then answers SIP_READY_TIMEOUT, which lands in the final branch below.
        if (this.notReadyRetries++ < NOT_READY_MAX_RETRIES) {
          const ws = this.ws;
          setTimeout(() => { if (!this.closed && this.ws === ws) this.send(1, { conn_init: { version: 1 } }); }, NOT_READY_RETRY_MS);
        } else {
          this.end("control_rejected:NOT_READY");
        }
      } else {
        // Anything else (SIP_READY_TIMEOUT, LIVE_ENDED, LIVE_CONN_INIT_FAILED) is final.
        console.error("[useViduRealtime] control channel rejected", ack);
        this.end(`control_rejected:${ack.error_code || "unknown"}`);
      }
      return;
    }
    if (msg?.type === 14) {
      const failure = (msg.payload && (Object.values(msg.payload)[0] as SwitchFailure)) || {};
      console.error("[useViduRealtime] switch_prompt failed", failure);
      this.pendingSwitch?.(failure);
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

// Decodes the base64 rtc.token Vidu returns into AliRTC's joinChannel auth object.
function parseAuthInfo(rtcToken: string) {
  const decoded = JSON.parse(atob(rtcToken));
  const authInfo = {
    appId: decoded.appid as string,
    channelId: decoded.channelid as string,
    userId: decoded.userid as string,
    nonce: (decoded.nonce as string) || undefined,
    timestamp: decoded.timestamp as number,
    token: decoded.token as string,
  };
  if (!authInfo.appId || !authInfo.channelId || !authInfo.userId || !authInfo.token) throw new Error("incomplete");
  return authInfo;
}

// Elite AI background, chained after the character swap (Professional/Enterprise keys).
// Vidu runs one editing_type per live stream, so the background is a second live stream
// (editing_type=background_replacement) whose input is the first stream's swapped output,
// published through AliRTC's switchCamera(…, track) instead of a camera. Its own output then
// replaces the first stream's as the studio output. Costs a second Vidu stream per user.
class ViduBackgroundLeg {
  private engine: any = null;
  private control: ViduControlChannel | null = null;
  private renderUid: string | null = null;
  private delivered: MediaStreamTrack | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  // The SDK stops whatever track it was fed when the engine is destroyed, so this leg only ever
  // gets a clone of the character output; stopping the background then leaves the original live
  // (verified: feeding the original froze the output when the background was turned off).
  private inputClone: MediaStreamTrack | null = null;

  private cloneInput(track: MediaStreamTrack) {
    const prev = this.inputClone;
    this.inputClone = track.clone();
    prev?.stop();
    return this.inputClone as MediaStreamVideoTrack;
  }

  constructor(
    private readonly onOutput: (track: MediaStreamTrack) => void,
    private readonly onEnded: (reason: string) => void,
  ) {}

  async start(params: { pKey: string; sessionId: string; resolution?: string; backgroundDataUri: string; input: MediaStreamTrack }) {
    const session = await mintViduSession(
      { p_key: params.pKey, p_session_id: params.sessionId, resolution: params.resolution, image_url: params.backgroundDataUri, editing_type: "background_replacement" },
      "Could not start the Elite AI background",
    );
    if (!session.rtc?.token || !session.render_uid || !session.live_id || !session.client_secret) {
      throw new Error("The Elite AI background request was rejected");
    }
    if (this.stopped) return;
    this.renderUid = session.render_uid;
    this.control = new ViduControlChannel(session.control_url || DEFAULT_CONTROL_URL, session.live_id, session.client_secret, (r) => this.fail(r));
    this.control.open();

    const AliRtc = await loadAliRtc();
    const engine = AliRtc.default.createInstance();
    this.engine = engine;
    const isRender = (uid: string) => uid === this.renderUid;
    engine.on("remoteTrackAvailableNotify", (uid: string) => { if (isRender(uid)) void this.tryDeliver(); });
    engine.on("videoSubscribeStateChanged", (uid: string, _p: number, next: number) => {
      if (isRender(uid) && next === AliRtc.AliRtcSubscribeState.AliRtcStateSubscribed) void this.tryDeliver();
    });
    engine.on("remoteUserOffLineNotify", (uid: string, reason: number) => {
      if (isRender(uid) && reason === USER_OFFLINE_QUIT && this.delivered) this.fail("render_left");
    });
    engine.on("connectionStatusChange", (status: number) => {
      if (status === AliRtc.AliRtcConnectionStatus.AliRtcConnectionStatusFailed) this.fail("connection_failed");
    });
    engine.setDefaultSubscribeAllRemoteAudioStreams(false);

    // Feed the character-swapped track in place of a camera. No microphone on this leg.
    await withTimeout(engine.switchCamera(undefined, this.cloneInput(params.input)), PREVIEW_TIMEOUT_MS, "Couldn't feed the swapped video to the Elite AI background");
    await withTimeout(engine.joinChannel(parseAuthInfo(session.rtc.token), "eliteswap-bg"), JOIN_TIMEOUT_MS, "Elite AI background connection timed out");
    try { await engine.publishLocalAudioStream(false); } catch { /* noop */ }
    try { await engine.publishLocalVideoStream(true); } catch { /* noop */ }

    void this.tryDeliver();
    this.poll = setInterval(() => void this.tryDeliver(), REMOTE_POLL_MS);
    this.watchdog = setTimeout(() => { if (!this.delivered) this.fail("no_output"); }, OUTPUT_TIMEOUT_MS);
  }

  // The character leg's output track can be replaced on re-subscription; keep feeding the new one.
  async setInput(track: MediaStreamTrack) {
    if (this.stopped || !this.engine) return;
    try { await this.engine.switchCamera(undefined, this.cloneInput(track)); } catch (e) { console.warn("[useViduRealtime] bg setInput failed", e); }
  }

  switchBackground(dataUri: string): Promise<SwitchFailure | null> {
    return this.control ? this.control.switchPrompt({ imageDataUri: dataUri }) : Promise.resolve({ error_code: "NOT_CONNECTED" });
  }

  private async tryDeliver() {
    if (this.stopped || !this.engine || !this.renderUid) return;
    try {
      const { AliRtcRawDataStreamType } = await loadAliRtc();
      const track: MediaStreamTrack | undefined = await this.engine.getVideoTrack({ userId: this.renderUid, streamType: AliRtcRawDataStreamType.AliRtcSdkStreamTypeCapture });
      if (!track || this.stopped || track === this.delivered) return;
      this.delivered = track;
      if (this.poll) { clearInterval(this.poll); this.poll = null; }
      if (this.watchdog) { clearTimeout(this.watchdog); this.watchdog = null; }
      this.onOutput(track);
    } catch { /* not ready yet */ }
  }

  private fail(reason: string) {
    if (this.stopped) return;
    console.warn("[useViduRealtime] Elite AI background ended:", reason);
    void this.stop();
    this.onEnded(reason);
  }

  async stop() {
    this.stopped = true;
    if (this.poll) clearInterval(this.poll);
    if (this.watchdog) clearTimeout(this.watchdog);
    this.control?.hangup();
    this.control = null;
    const engine = this.engine;
    this.engine = null;
    try { await engine?.leaveChannel?.(); } catch { /* noop */ }
    try { await engine?.destroy?.(); } catch { /* noop */ }
    this.inputClone?.stop();
    this.inputClone = null;
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
  const sessionParamsRef = useRef<{ pKey: string; sessionId: string; resolution?: string } | null>(null);
  const bgLegRef = useRef<ViduBackgroundLeg | null>(null);
  const [backgroundState, setBackgroundState] = useState<"off" | "starting" | "on">("off");
  // Vidu won't reuse an RTMP push address for ~10s after the stream that used it ends; a relay
  // that fails to start ends the whole session, so a quick reconnect waits that out first.
  const relayingRef = useRef(false);
  const relayEndedAtRef = useRef(0);

  const stopBackgroundLeg = useCallback(async () => {
    const leg = bgLegRef.current;
    bgLegRef.current = null;
    setBackgroundState("off");
    if (leg) await leg.stop();
  }, []);

  const stopTimers = useCallback(() => {
    if (remotePollRef.current) { clearInterval(remotePollRef.current); remotePollRef.current = null; }
    if (outputWatchdogRef.current) { clearTimeout(outputWatchdogRef.current); outputWatchdogRef.current = null; }
  }, []);

  const handleEnded = useCallback((rawReason: string) => {
    if (endingRef.current) return;
    endingRef.current = true;
    console.warn("[useViduRealtime] session ended by Vidu:", rawReason);
    // Vidu sometimes ends a stream ~14s in without ever publishing output (hangup "live_ended",
    // close_reason "user_end", 0s billed; seen live 2026-11-18). A relay that can't reach its
    // RTMP address ends the same way, with nothing more specific. Report both distinctly so the
    // studio can retry the first and point at the Go live settings for the second.
    const beforeOutput = !deliveredTrackRef.current && !/audit|violation|credit/i.test(rawReason);
    const reason = !beforeOutput || rawReason === "no_output"
      ? rawReason
      : relayingRef.current ? "relay_start_failed" : "start_failed";
    stopTimers();
    void stopBackgroundLeg();
    controlRef.current?.hangup();
    controlRef.current = null;
    void releaseEngine(engineRef.current);
    engineRef.current = null;
    if (relayingRef.current) { relayingRef.current = false; relayEndedAtRef.current = Date.now(); }
    setError(describeViduEnd(reason));
    setConnectionState("disconnected");
    const onEnded = onEndedRef.current;
    onEndedRef.current = null;
    onEnded?.(reason);
  }, [stopTimers, stopBackgroundLeg]);

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
      // With the AI background on, the character output feeds the background stream instead of
      // the studio output.
      if (bgLegRef.current) void bgLegRef.current.setInput(videoTrack);
      else onRemoteStreamRef.current?.(new MediaStream([videoTrack]));
      setConnectionState("connected");
    } catch (err) {
      console.warn("[useViduRealtime] Failed to materialize the remote stream", err);
    }
  }, [stopTimers]);

  const connect = useCallback(async (params: ViduConnectParams) => {
    const { pKey, sessionId, referenceImageDataUri, editingType, rtmpUrls, resolution, facing, cameraOnly, onRemoteStream, onEnded } = params;
    endingRef.current = false;
    sessionParamsRef.current = { pKey, sessionId, resolution };
    setConnectionState("connecting");
    setError(null);
    deliveredTrackRef.current = null;
    onRemoteStreamRef.current = onRemoteStream;
    // Armed only once connect() succeeds; an end before that surfaces as connect()'s own error.
    onEndedRef.current = null;

    try {
      if (rtmpUrls?.length) {
        const wait = relayEndedAtRef.current + RTMP_ADDRESS_COOLDOWN_MS - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
      const session = await mintViduSession({
        p_key: pKey,
        p_session_id: sessionId,
        image_url: referenceImageDataUri,
        editing_type: editingType,
        resolution,
        ...(rtmpUrls?.length ? { rtmp_urls: rtmpUrls } : {}),
      }, CONNECT_FAILED);
      // The background leg uses what the server actually granted, so both streams match.
      if (session.resolution) sessionParamsRef.current = { pKey, sessionId, resolution: session.resolution };

      const rtc = session.rtc;
      renderUidRef.current = session.render_uid || null;
      if (!rtc?.token || !renderUidRef.current) throw new Error(SESSION_START_FAILED);
      if (!session.live_id || !session.client_secret) throw new Error(SESSION_START_FAILED);

      const control = new ViduControlChannel(session.control_url || DEFAULT_CONTROL_URL, session.live_id, session.client_secret, handleEnded);
      controlRef.current = control;
      relayingRef.current = !!session.relaying;
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
        throw new Error(SESSION_START_FAILED);
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
        setError("Studio connection problem. If the video stops, reconnect.");
      });

      engine.setDefaultSubscribeAllRemoteAudioStreams(false);
      // Only ever set for the rear camera: a facing constraint can't be met by a desktop webcam.
      if (facing === "rear") {
        try { await engine.setCameraCapturerConfiguration({ cameraDirection: CAMERA_REAR }); } catch { /* keep the default camera */ }
      }

      // Don't add enableLocalVideo(true) here: it reintroduced a stuck-on-connecting hang in live testing.
      try {
        await withTimeout(engine.startPreview(), PREVIEW_TIMEOUT_MS, "Could not access your camera. Check camera permissions and try again.");
      } catch (previewErr) {
        console.error("[useViduRealtime] startPreview failed", previewErr);
        throw previewErr;
      }

      // startPreview() opens only the camera; the SDK opens the microphone when it joins and
      // publishes. Call mode turns that off first so the phone's calling app keeps the mic.
      if (cameraOnly) {
        try { await engine.publishLocalAudioStream(false); } catch { /* noop */ }
      }
      await withTimeout(engine.joinChannel(authInfo, "eliteswap-user"), JOIN_TIMEOUT_MS, "Connection timed out");
      if (cameraOnly) {
        try { engine.stopAudioCapture(); } catch { /* noop */ }
      }

      void tryDeliverRemoteStream();
      if (!deliveredTrackRef.current) {
        remotePollRef.current = setInterval(() => void tryDeliverRemoteStream(), REMOTE_POLL_MS);
        outputWatchdogRef.current = setTimeout(() => {
          if (!deliveredTrackRef.current) handleEnded("no_output");
        }, OUTPUT_TIMEOUT_MS);
      }

      // DeepfakeStudio's camera panel expects the local stream back, like Decart's connect().
      const localVideoTrack = await engine.getVideoTrack({ streamType: AliRtc.AliRtcRawDataStreamType.AliRtcSdkStreamTypeCapture }).catch(() => undefined);
      const localAudioTrack = cameraOnly ? undefined : await engine.getAudioTrack().catch(() => undefined);
      const localTracks: MediaStreamTrack[] = [];
      if (localVideoTrack) localTracks.push(localVideoTrack);
      if (localAudioTrack) localTracks.push(localAudioTrack);
      const localStream = localTracks.length > 0 ? new MediaStream(localTracks) : null;
      if (!localStream) {
        console.warn("[useViduRealtime] joined successfully but no local track was available to return");
      }

      if (endingRef.current) throw new Error("The session ended before it finished connecting. Please try again.");
      onEndedRef.current = onEnded ?? null;
      return {
        engine,
        liveId: session.live_id as string,
        stream: localStream,
        resolution: (session.resolution as string | undefined) ?? null,
        relaying: !!session.relaying,
      };
    } catch (err: any) {
      endingRef.current = true;
      stopTimers();
      controlRef.current?.hangup();
      controlRef.current = null;
      if (relayingRef.current) { relayingRef.current = false; relayEndedAtRef.current = Date.now(); }
      await releaseEngine(engineRef.current);
      engineRef.current = null;
      setError(brandMessage(err?.message, CONNECT_FAILED));
      setConnectionState("disconnected");
      throw err;
    }
  }, [handleEnded, stopTimers, tryDeliverRemoteStream]);

  // Phones: swap between front and rear cameras mid-session. The SDK keeps publishing to Vidu
  // with the new camera; returns the new local stream for the camera panel.
  const flipCamera = useCallback(async (): Promise<{ ok: true; stream: MediaStream } | { ok: false; message: string }> => {
    const engine = engineRef.current;
    if (!engine || endingRef.current) return { ok: false, message: "Connect first, then flip the camera." };
    try {
      await engine.switchCamera();
      const { AliRtcRawDataStreamType } = await loadAliRtc();
      const video: MediaStreamTrack | undefined = await engine.getVideoTrack({ streamType: AliRtcRawDataStreamType.AliRtcSdkStreamTypeCapture }).catch(() => undefined);
      const audio: MediaStreamTrack | undefined = await engine.getAudioTrack().catch(() => undefined);
      if (!video) return { ok: false, message: "The other camera didn't start." };
      return { ok: true, stream: new MediaStream(audio ? [video, audio] : [video]) };
    } catch (e) {
      console.warn("[useViduRealtime] switchCamera failed", e);
      return { ok: false, message: "This device has no other camera to switch to." };
    }
  }, []);

  // Change the reference photo (and optionally the editing mode) without reconnecting.
  // The picture switches within a few seconds; no extra Vidu charge.
  const switchReference = useCallback(async (imageDataUri: string, editingType?: string) => {
    const control = controlRef.current;
    if (!control) return { ok: false, message: "Connect first, then pick the new photo." };
    const failure = await control.switchPrompt({ imageDataUri, editingType });
    if (failure) return { ok: false, message: switchFailureMessage(failure, "Couldn't switch to that photo. Try a different one.") };
    return { ok: true as const };
  }, []);

  // Start the chained Elite AI background (second Vidu stream) on a live character session.
  // onFallback runs if it stops on its own; the character-only output is restored first.
  const startBackground = useCallback(async (backgroundDataUri: string, onFallback?: (reason: string) => void) => {
    const input = deliveredTrackRef.current;
    const params = sessionParamsRef.current;
    if (!input || !params || endingRef.current) return { ok: false, message: "Connect first, then pick a background." };
    if (bgLegRef.current) {
      const failure = await bgLegRef.current.switchBackground(backgroundDataUri);
      return failure ? { ok: false, message: switchFailureMessage(failure, "Couldn't switch the background. Try a different image.") } : { ok: true as const };
    }
    setBackgroundState("starting");
    const leg = new ViduBackgroundLeg(
      (track) => {
        if (bgLegRef.current !== leg) return;
        setBackgroundState("on");
        onRemoteStreamRef.current?.(new MediaStream([track]));
      },
      (reason) => {
        if (bgLegRef.current !== leg) return;
        bgLegRef.current = null;
        setBackgroundState("off");
        const characterTrack = deliveredTrackRef.current;
        if (characterTrack && !endingRef.current) onRemoteStreamRef.current?.(new MediaStream([characterTrack]));
        onFallback?.(reason);
      },
    );
    bgLegRef.current = leg;
    try {
      await leg.start({ ...params, backgroundDataUri, input });
      return { ok: true as const };
    } catch (e: any) {
      if (bgLegRef.current === leg) { bgLegRef.current = null; setBackgroundState("off"); }
      await leg.stop();
      return { ok: false, message: brandMessage(e?.message, "Couldn't start the Elite AI background. Please try again.") };
    }
  }, []);

  // Back to the character-only output; ends the second Vidu stream.
  const stopBackground = useCallback(async () => {
    const characterTrack = deliveredTrackRef.current;
    await stopBackgroundLeg();
    if (characterTrack && !endingRef.current) onRemoteStreamRef.current?.(new MediaStream([characterTrack]));
  }, [stopBackgroundLeg]);

  const disconnect = useCallback(async () => {
    endingRef.current = true;
    await stopBackgroundLeg();
    stopTimers();
    controlRef.current?.hangup();
    controlRef.current = null;
    if (relayingRef.current) { relayingRef.current = false; relayEndedAtRef.current = Date.now(); }
    await releaseEngine(engineRef.current);
    engineRef.current = null;
    renderUidRef.current = null;
    deliveredTrackRef.current = null;
    onRemoteStreamRef.current = null;
    onEndedRef.current = null;
    setConnectionState("disconnected");
  }, [stopTimers, stopBackgroundLeg]);

  useEffect(() => {
    const onPageHide = () => { controlRef.current?.hangup(); void bgLegRef.current?.stop(); };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      endingRef.current = true;
      if (remotePollRef.current) clearInterval(remotePollRef.current);
      if (outputWatchdogRef.current) clearTimeout(outputWatchdogRef.current);
      controlRef.current?.hangup();
      void bgLegRef.current?.stop();
      void releaseEngine(engineRef.current);
    };
  }, []);

  return {
    connectionState,
    error,
    connect,
    disconnect,
    switchReference,
    flipCamera,
    backgroundState,
    startBackground,
    stopBackground,
  };
}
