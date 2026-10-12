// Mints a short-lived Vidu S2 realtime join credential for a session the
// caller already opened via mint_studio_credentials() (the single studio
// connect chokepoint -- see supabase/migrations/20261012120000_vidu_dual_provider_plumbing.sql).
//
// Why this exists as a separate edge function instead of living inside that
// RPC: Decart hands its raw pooled API key straight back to the browser,
// which connects to Decart directly. Vidu's auth model doesn't allow that --
// minting a join credential requires a server-to-server REST call
// (POST /live/s_editing/realtime) authenticated with the raw Vidu API key,
// which must never reach the browser. A synchronous outbound HTTPS call
// like that isn't something a Postgres RPC should be doing, so it lives
// here in Deno instead, using a pooled key resolved via the service-role
// client.
//
// Vidu API shape -- fully hands-on confirmed against a live account on
// 2026-10-12, including one real 200 response. Key findings, each found the
// hard way (the public docs / reference repo got more than one of these
// wrong):
//   - Endpoint: POST https://api.vidu.com/live/s_editing/realtime
//   - Auth: Authorization: Token vda_xxx
//   - Body: { image_url, editing_type }. editing_type is one of
//     style_transfer (Vidu's API default), virtual_tryon,
//     subject_replacement, background_replacement -- NOT "face_swap", which
//     doesn't exist. We default to subject_replacement: it's what Vidu's own
//     character-swap page uses, and it's confirmed live to replace the
//     person on camera with the reference character (style_transfer only
//     repaints the video in the reference's look).
//   - image_url MUST be an inline base64 data URI (data:image/...;base64,...).
//     A real, publicly-reachable external https:// URL in the same field
//     consistently 500s ({"reason":"editing_liveO100live"}) -- reproduced
//     across 2 API keys, multiple images, and every editing_type value,
//     including the documented default. Only switching to base64 fixed it.
//     This is actually simpler for us: no image upload/hosting step needed.
//   - A successful response's `rtc` block uses provider "artc" (Aliyun RTC)
//     for sessions minted this way -- not Volcengine, which is what Vidu's
//     own web app requests explicitly via a completely separate,
//     cookie-session-authenticated internal endpoint
//     (service.vidu.com/live/v1/live/claim) that flatly rejects API-key
//     auth (401) and is not a path available to a third-party integration.
//   - Confirmed real response shape: { live: { id, stream_url, ... },
//     client_secret, rtc: { app_id, channel_id, user_id, token,
//     token_expire_at, provider }, render_uid }. render_uid is the identity
//     the AI-transformed output is published under -- distinct from
//     rtc.user_id, which is this session's own publish identity.
//   - client_secret authenticates the session's control WebSocket on its
//     own (no API key), so the browser opens it directly -- see
//     useViduRealtime.ts. control_url tells it where, matching VIDU_API_HOST.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const VIDU_API_HOST = Deno.env.get("VIDU_API_HOST") || "https://api.vidu.com";
const VIDU_CONTROL_URL = `${VIDU_API_HOST.replace(/^http/, "ws")}/live/ws/live/connect`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json({ code: "UNAUTHORIZED", message: "Sign in required" }, 401);
    }
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

    const userClient = createClient(SUPABASE_URL, ANON, {
      global: { headers: { Authorization: authHeader } },
    });
    const token = authHeader.replace("Bearer ", "");
    const { data: ud, error: ue } = await userClient.auth.getUser(token);
    if (ue || !ud?.user) return json({ code: "UNAUTHORIZED", message: "Invalid session" }, 401);
    const userId = ud.user.id;

    const body = await req.json().catch(() => ({}));
    const pKey = String(body?.p_key || "").trim();
    const sessionId = String(body?.p_session_id || "").trim();
    const imageDataUri = body?.image_url;
    const editingType = typeof body?.editing_type === "string" && body.editing_type.trim()
      ? body.editing_type.trim()
      : "subject_replacement";

    if (!pKey || !sessionId) {
      return json({ code: "BAD_REQUEST", message: "p_key and p_session_id are required" }, 400);
    }
    // Must be inline base64, NOT a hosted URL -- Vidu's external-URL fetch
    // path is confirmed broken server-side (see header comment). A plain
    // http(s):// URL would pass this check but reliably 500 at Vidu, so
    // reject it early with a clear reason instead of spending a pooled key
    // on a doomed request.
    if (!imageDataUri || typeof imageDataUri !== "string" || !imageDataUri.startsWith("data:image/")) {
      return json({ code: "BAD_REQUEST", message: "image_url must be an inline data:image/...;base64,... URI" }, 400);
    }

    const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

    // Re-prove ownership of a session mint_studio_credentials really did
    // open for this user -- don't spend a pooled Vidu key on anyone's say-so.
    const { data: keyRow, error: keyErr } = await admin
      .from("api_keys")
      .select("id, active_session_id")
      .eq("key", pKey)
      .eq("user_id", userId)
      .maybeSingle();
    if (keyErr) return json({ code: "DB_ERROR", message: keyErr.message }, 500);
    if (!keyRow || keyRow.active_session_id !== sessionId) {
      return json({ code: "FORBIDDEN", message: "Not an active session for this key" }, 403);
    }

    const { data: sessionRow, error: sessionErr } = await admin
      .from("studio_sessions")
      .select("session_id, ended_at")
      .eq("session_id", sessionId)
      .eq("user_id", userId)
      .is("ended_at", null)
      .maybeSingle();
    if (sessionErr) return json({ code: "DB_ERROR", message: sessionErr.message }, 500);
    if (!sessionRow) return json({ code: "FORBIDDEN", message: "Session is not active" }, 403);

    const { data: config } = await admin
      .from("studio_pricing_config")
      .select("active_provider")
      .eq("id", true)
      .maybeSingle();
    if ((config as any)?.active_provider !== "vidu") {
      return json({ code: "PROVIDER_MISMATCH", message: "Vidu is not the active provider right now" }, 409);
    }

    // Queried directly (not via assign_shared_vidu_key()) so the chosen
    // pool row's id can be recorded on the session for auditing.
    const { data: poolRow, error: poolErr } = await admin
      .from("vidu_shared_pool")
      .select("id, vidu_api_key")
      .eq("is_active", true)
      .limit(50);
    if (poolErr) return json({ code: "DB_ERROR", message: poolErr.message }, 500);
    const activePool = (poolRow ?? []) as { id: string; vidu_api_key: string }[];
    if (activePool.length === 0) return json({ code: "NO_SHARED_KEY_AVAILABLE", message: "No active Vidu key in the pool" }, 503);
    const chosen = activePool[Math.floor(Math.random() * activePool.length)];
    const viduKey = chosen.vidu_api_key;

    let viduRes: Response;
    try {
      viduRes = await fetch(`${VIDU_API_HOST}/live/s_editing/realtime`, {
        method: "POST",
        headers: {
          "Authorization": `Token ${viduKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          image_url: imageDataUri,
          editing_type: editingType,
        }),
      });
    } catch (fetchErr) {
      console.error("[mint-vidu-rtc-session] Vidu request failed", fetchErr);
      return json({ code: "VIDU_UNREACHABLE", message: "Could not reach Vidu" }, 502);
    }

    const viduBody = await viduRes.json().catch(() => null);
    if (!viduRes.ok || !viduBody) {
      console.error("[mint-vidu-rtc-session] Vidu returned an error", viduRes.status, viduBody);
      // Vidu's error shape (confirmed live): { code, reason, message, metadata }.
      // CreditInsufficient specifically means the pooled key's account is out
      // of balance -- surface it distinctly so an admin sees "top up Vidu"
      // rather than a generic failure indistinguishable from a bad request.
      if (viduBody?.reason === "CreditInsufficient") {
        return json({ code: "VIDU_CREDIT_INSUFFICIENT", message: "The pooled Vidu account is out of credit" }, 502);
      }
      return json({ code: "VIDU_ERROR", message: "Vidu rejected the session request" }, 502);
    }

    const rtc = viduBody.rtc || {};
    if (!rtc.token || !rtc.user_id || !rtc.app_id || !rtc.channel_id) {
      console.error("[mint-vidu-rtc-session] Vidu response missing rtc credentials", viduBody);
      return json({ code: "VIDU_ERROR", message: "Vidu did not return join credentials" }, 502);
    }

    try {
      await admin
        .from("studio_sessions")
        .update({ vidu_pool_key_id: chosen.id })
        .eq("session_id", sessionId)
        .eq("user_id", userId);
    } catch (e) {
      console.error("[mint-vidu-rtc-session] Failed to record vidu_pool_key_id", e);
    }

    return json({
      ok: true,
      live_id: viduBody.live?.id ?? null,
      rtc: {
        app_id: rtc.app_id,
        channel_id: rtc.channel_id,
        user_id: rtc.user_id,
        token: rtc.token,
        token_expire_at: rtc.token_expire_at ?? null,
        provider: rtc.provider ?? null,
      },
      // The identity the AI-transformed output is published under -- the
      // browser subscribes to this, separately from publishing its own
      // camera feed under rtc.user_id.
      render_uid: viduBody.render_uid ?? null,
      client_secret: viduBody.client_secret ?? null,
      control_url: VIDU_CONTROL_URL,
    });
  } catch (e) {
    console.error("[mint-vidu-rtc-session]", e);
    return json({ code: "ERROR", message: "Unexpected error" }, 500);
  }
});
