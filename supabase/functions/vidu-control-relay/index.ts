// Relays the Vidu control WebSocket (wss://api.vidu.com/live/ws/live/connect)
// between the browser and Vidu, and performs the conn_init handshake that
// actually starts a session producing output.
//
// Why this exists: a Vidu realtime editing session created via
// mint-vidu-rtc-session comes back in "waiting" status. The AliRTC media
// join (useViduRealtime.ts) succeeds independently of this -- that's why
// the local camera panel worked in live testing while the swapped output
// never appeared. Per Vidu's own Node.js reference server
// (shengshu-ai/vidu-s-api, examples/node-quickstart/server.js), there is no
// separate "start processing" message: completing this control channel's
// conn_init handshake (getting conn_init_ack with success=true) is what
// moves the session out of "waiting" and makes it start publishing.
//
// This control channel authenticates with the raw Vidu API key
// (Authorization: Token vda_xxx on the WS handshake itself), so -- same as
// the REST mint call -- it has to happen server-side; the raw key must
// never reach the browser. It must reuse the SAME pooled key
// mint-vidu-rtc-session used for this session's live_id (recorded in
// studio_sessions.vidu_pool_key_id), since Vidu scopes a live_id to the
// account/key that created it.
//
// Using npm:ws for the OUTBOUND connection to Vidu rather than Deno's
// native global WebSocket: setting custom headers on an outbound
// WebSocket handshake is a very recent (~Deno 2.5, Sept 2025) addition to
// Deno's native WebSocket, and it's unconfirmed whether Supabase's edge
// runtime is current enough to have it. `ws` is what Vidu's own reference
// server uses for exactly this (confirmed working), and it's pure JS with
// no native bindings, so it should be Deno-npm-compatible without issue --
// the safer bet given this piece can't be tested without a live deploy.
//
// Message envelope (confirmed from the reference server):
//   { type: 1, live_id, conn_id, seq_id, payload: { conn_init: { version: 1 } } }
// Vidu acks with type 2, payload.conn_init_ack.success === true/false.
import { createClient } from "npm:@supabase/supabase-js@2";
import { WebSocket as NodeWebSocket } from "npm:ws@8";

const VIDU_WS_HOST = Deno.env.get("VIDU_WS_HOST") || "wss://api.vidu.com";

Deno.serve(async (req) => {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }

  const url = new URL(req.url);
  const accessToken = url.searchParams.get("access_token") || "";
  const pKey = url.searchParams.get("p_key") || "";
  const sessionId = url.searchParams.get("p_session_id") || "";
  const liveId = url.searchParams.get("live_id") || "";
  const clientSecret = url.searchParams.get("client_secret") || "";

  if (!accessToken || !pKey || !sessionId || !liveId) {
    return new Response("Missing required params", { status: 400 });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

  const userClient = createClient(SUPABASE_URL, ANON, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const { data: ud, error: ue } = await userClient.auth.getUser(accessToken);
  if (ue || !ud?.user) return new Response("Unauthorized", { status: 401 });
  const userId = ud.user.id;

  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

  // Same ownership re-proof pattern as mint-vidu-rtc-session.
  const { data: keyRow } = await admin
    .from("api_keys")
    .select("id, active_session_id")
    .eq("key", pKey)
    .eq("user_id", userId)
    .maybeSingle();
  if (!keyRow || keyRow.active_session_id !== sessionId) {
    return new Response("Not an active session for this key", { status: 403 });
  }

  const { data: sessionRow } = await admin
    .from("studio_sessions")
    .select("session_id, ended_at, vidu_pool_key_id")
    .eq("session_id", sessionId)
    .eq("user_id", userId)
    .is("ended_at", null)
    .maybeSingle();
  if (!sessionRow || !(sessionRow as any).vidu_pool_key_id) {
    return new Response("Session is not active or has no recorded Vidu key", { status: 403 });
  }

  const { data: poolRow } = await admin
    .from("vidu_shared_pool")
    .select("vidu_api_key")
    .eq("id", (sessionRow as any).vidu_pool_key_id)
    .maybeSingle();
  if (!(poolRow as any)?.vidu_api_key) {
    return new Response("Could not resolve the Vidu key for this session", { status: 500 });
  }
  const viduApiKey = (poolRow as any).vidu_api_key as string;

  const { socket: browserSocket, response } = Deno.upgradeWebSocket(req);

  const connId = crypto.randomUUID();
  const query = new URLSearchParams({ live_id: liveId, conn_id: connId });
  if (clientSecret) query.set("client_secret", clientSecret);
  const viduWsUrl = `${VIDU_WS_HOST}/live/ws/live/connect?${query.toString()}`;

  let viduSocket: InstanceType<typeof NodeWebSocket> | null = null;
  let seqId = 1;

  const sendToVidu = (payload: Record<string, unknown>) => {
    if (!viduSocket || viduSocket.readyState !== NodeWebSocket.OPEN) return;
    viduSocket.send(JSON.stringify({ type: 1, live_id: liveId, conn_id: connId, seq_id: seqId++, payload }));
  };

  const closeBoth = () => {
    try { viduSocket?.close(); } catch { /* noop */ }
    try { browserSocket.close(); } catch { /* noop */ }
  };

  browserSocket.onopen = () => {
    viduSocket = new NodeWebSocket(viduWsUrl, {
      headers: { Authorization: `Token ${viduApiKey}` },
    });

    viduSocket.on("open", () => {
      sendToVidu({ conn_init: { version: 1 } });
    });
    viduSocket.on("message", (data: unknown) => {
      try {
        const text = typeof data === "string" ? data : (data as any)?.toString?.() ?? String(data);
        browserSocket.send(text);
      } catch (e) {
        console.error("[vidu-control-relay] forward to browser failed", e);
      }
    });
    viduSocket.on("close", () => closeBoth());
    viduSocket.on("error", (err: unknown) => {
      console.error("[vidu-control-relay] Vidu WS error", err);
      closeBoth();
    });
  };

  // v1: no browser-initiated actions (switch_prompt/hangup) relayed yet --
  // only the one-way conn_init handshake needed to unblock output.
  browserSocket.onclose = () => { try { viduSocket?.close(); } catch { /* noop */ } };
  browserSocket.onerror = () => { try { viduSocket?.close(); } catch { /* noop */ } };

  return response;
});
