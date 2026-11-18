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
//   - Added 2026-11 from Vidu's 2026-10 API update: `resolution` (output size,
//     chosen per plan below) and `rtmp_urls` (Vidu relays the swapped output
//     straight to the user's YouTube/Twitch/TikTok ingest -- "Go live").
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

// Output resolution (Vidu's `resolution` create parameter, added 2026-10). Live-checked
// 2026-11-18: Vidu bills editing streams a flat 1 credit/sec at every resolution (24 s = 24
// credits at 540p, 720p and 1080p). Output for a 16:9 camera: 952x544 / 1268x724 / 1904x1088,
// at roughly 2.7 / 3.6 / 4.7 Mbps download -- so the user may pick a lower one ("Data saver").
// Each plan has a ceiling; the env vars are a no-redeploy lever
// (`supabase secrets set VIDU_RESOLUTION_DEFAULT=540p` restores the old output for everyone).
const RESOLUTION_ORDER = ["540p", "720p", "1080p", "2K"];
const envResolution = (name: string, fallback: string) => {
  const v = (Deno.env.get(name) || "").trim();
  return RESOLUTION_ORDER.includes(v) ? v : fallback;
};
const RESOLUTION_DEFAULT = envResolution("VIDU_RESOLUTION_DEFAULT", "720p");
const RESOLUTION_PRO = envResolution("VIDU_RESOLUTION_PRO", "1080p");
const PRO_TIERS = new Set(["Professional", "Enterprise"]);
// The requested resolution, capped at the plan's ceiling; no (or an unknown) request gets the ceiling.
function pickResolution(requested: unknown, ceiling: string): string {
  const r = RESOLUTION_ORDER.indexOf(String(requested ?? ""));
  return r >= 0 && r < RESOLUTION_ORDER.indexOf(ceiling) ? RESOLUTION_ORDER[r] : ceiling;
}

// Direct streaming: Vidu relays the swapped output to the user's own RTMP ingest addresses.
// Vidu only takes plain rtmp:// (no rtmps://), at most 5 entries of <= 2048 chars. Stream
// keys are secrets: they are passed straight through, never stored, and never logged.
const MAX_RTMP_URLS = 2;
// Admin-only until a relay to a real platform has been confirmed; `supabase secrets set
// VIDU_GO_LIVE=all` opens it to every paid key without a redeploy.
const GO_LIVE_FOR_ALL = (Deno.env.get("VIDU_GO_LIVE") || "").trim().toLowerCase() === "all";
function parseRtmpUrls(raw: unknown): string[] | { error: string } {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return { error: "rtmp_urls must be a list" };
  const urls = [...new Set(raw.map((u) => String(u ?? "").trim()).filter(Boolean))];
  if (urls.length > MAX_RTMP_URLS) return { error: `At most ${MAX_RTMP_URLS} streaming destinations` };
  for (const u of urls) {
    if (!/^rtmp:\/\/[^\s/]+\/\S+$/i.test(u) || u.length > 2048) {
      return { error: "Each streaming destination must be an rtmp:// server URL followed by your stream key" };
    }
  }
  return urls;
}

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
    const rtmpUrls = parseRtmpUrls(body?.rtmp_urls);
    if (!Array.isArray(rtmpUrls)) return json({ code: "RTMP_INVALID", message: rtmpUrls.error }, 400);

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

    // Plan tier of the key in use: key -> payment -> plan, as get_api_key_plan_tier() does.
    // Explicit lookups: there's no foreign key from api_keys.payment_id for PostgREST to embed.
    const planTier = async (): Promise<string | null> => {
      const { data: k } = await admin.from("api_keys").select("payment_id").eq("id", keyRow.id).maybeSingle();
      if (!k?.payment_id) return null;
      const { data: p } = await admin.from("payments").select("plan_id").eq("id", k.payment_id).maybeSingle();
      if (!p?.plan_id) return null;
      const { data: plan } = await admin.from("pricing_plans").select("name").eq("id", p.plan_id).maybeSingle();
      return plan?.name ?? null;
    };
    const [tier, { data: isAdmin }] = await Promise.all([
      planTier(),
      admin.rpc("has_role", { _user_id: userId, _role: "admin" }),
    ]);
    const isPro = PRO_TIERS.has(tier ?? "") || !!isAdmin;

    // background_replacement is the Elite AI background: a second paid Vidu stream on top of
    // the character swap. It's a Professional/Enterprise feature, matched to the key in use
    // (as the studio's background panel is); admins and beta testers may use it on any key.
    if (editingType !== "subject_replacement" && !isPro) {
      const { data: beta } = await admin.from("user_beta_features").select("feature").eq("user_id", userId).eq("feature", "ai_background").maybeSingle();
      if (!beta) return json({ code: "FORBIDDEN", message: "Elite AI background needs a Professional or Enterprise key" }, 403);
    }
    const resolution = pickResolution(body?.resolution, isPro ? RESOLUTION_PRO : RESOLUTION_DEFAULT);

    const { data: sessionRow, error: sessionErr } = await admin
      .from("studio_sessions")
      .select("session_id, ended_at, is_trial")
      .eq("session_id", sessionId)
      .eq("user_id", userId)
      .is("ended_at", null)
      .maybeSingle();
    if (sessionErr) return json({ code: "DB_ERROR", message: sessionErr.message }, 500);
    if (!sessionRow) return json({ code: "FORBIDDEN", message: "Session is not active" }, 403);
    // The free-trial watermark is drawn by the studio page, so a direct stream would go out
    // without it: Go live is for paid keys.
    if (rtmpUrls.length && !isAdmin && !GO_LIVE_FOR_ALL) {
      return json({ code: "RTMP_NOT_AVAILABLE", message: "Go live isn't available on your account yet. Switch it off under Go live to connect." }, 403);
    }
    if (rtmpUrls.length && (sessionRow as any).is_trial && !isAdmin) {
      return json({ code: "RTMP_NOT_ON_TRIAL", message: "Go live is available on paid plans. Switch it off under Go live to use your free trial." }, 403);
    }

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
          resolution,
          ...(rtmpUrls.length ? { rtmp_urls: rtmpUrls } : {}),
        }),
      });
    } catch (fetchErr) {
      console.error("[mint-vidu-rtc-session] Vidu request failed", fetchErr);
      return json({ code: "VIDU_UNREACHABLE", message: "Could not reach Vidu" }, 502);
    }

    const viduBody = await viduRes.json().catch(() => null);
    if (!viduRes.ok || !viduBody) {
      // Vidu's error shape (confirmed live): { code, reason, message, metadata }. Logged without
      // the request, which can carry a user's stream key.
      console.error("[mint-vidu-rtc-session] Vidu returned an error", viduRes.status,
        JSON.stringify({ reason: viduBody?.reason, message: viduBody?.message, trace_id: viduBody?.metadata?.trace_id, rtmp: rtmpUrls.length > 0, resolution, editingType }));
      // CreditInsufficient means the pooled key's account is out of balance -- surface it
      // distinctly so an admin sees "top up Vidu" rather than a generic failure.
      if (viduBody?.reason === "CreditInsufficient") {
        return json({ code: "VIDU_CREDIT_INSUFFICIENT", message: "The studio is briefly at capacity. Please try again in a few minutes." }, 502);
      }
      // 429 = the Vidu account is running its maximum number of simultaneous streams (5 per account).
      if (viduRes.status === 429) {
        return json({ code: "VIDU_BUSY", message: "The studio is busy right now. Please try again in a minute." }, 503);
      }
      if (viduRes.status === 400 && rtmpUrls.length && /rtmp/i.test(`${viduBody?.reason} ${viduBody?.message}`)) {
        return json({ code: "RTMP_INVALID", message: "Your streaming server URL or stream key wasn't accepted. Check it under Go live and try again." }, 400);
      }
      return json({ code: "VIDU_ERROR", message: "Vidu rejected the session request" }, 502);
    }

    const rtc = viduBody.rtc || {};
    if (!rtc.token || !rtc.user_id || !rtc.app_id || !rtc.channel_id) {
      console.error("[mint-vidu-rtc-session] Vidu response missing rtc credentials", Object.keys(viduBody), Object.keys(rtc));
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
      resolution,
      relaying: rtmpUrls.length > 0,
    });
  } catch (e) {
    console.error("[mint-vidu-rtc-session]", e);
    return json({ code: "ERROR", message: "Unexpected error" }, 500);
  }
});
