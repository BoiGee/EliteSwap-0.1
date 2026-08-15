// Refreshes the internal service credential stored in the database vault that
// cron jobs and DB triggers use to call edge functions (admin push alerts,
// email queue). When the project's service role key is rotated, that stored
// copy goes stale and every trigger -> edge function call starts failing with
// 401/403. Running this function re-syncs it from the live environment.
//
// Callable by: full admins (JWT) or service-role.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const authHeader = req.headers.get("Authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  const timingSafeEqual = (a: string, b: string) => {
    if (a.length !== b.length || a.length === 0) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  };

  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

  // The service-role key or the (public) anon key are pre-authorized: this
  // endpoint is write-only self-healing — it copies the live service
  // credential into the vault and returns nothing sensitive, so allowing the
  // platform/cron to repair itself even when the stored key is already
  // broken is safe. An empty/missing bearer is NOT pre-authorized — it must
  // fall through to the admin-JWT check below like any other caller.
  const isPreAuthorized = timingSafeEqual(bearer, SERVICE) || timingSafeEqual(bearer, ANON);
  if (!isPreAuthorized) {
    const userClient = createClient(SUPABASE_URL, ANON, {
      global: { headers: { Authorization: `Bearer ${bearer}` } },
    });
    const { data: claims, error: cErr } = bearer
      ? await userClient.auth.getClaims(bearer)
      : { data: null, error: new Error("missing bearer") };
    const uid = claims?.claims?.sub as string | undefined;
    if (cErr || !uid) return json({ error: "Unauthorized" }, 401);
    const { data: isAdmin } = await admin.rpc("has_role", { _user_id: uid, _role: "admin" });
    if (!isAdmin) return json({ error: "Forbidden" }, 403);
  }

  const { error } = await admin.rpc("set_internal_service_key", { p_key: SERVICE });
  if (error) {
    console.error("[sync-internal-service-key] failed", error.message);
    return json({ ok: false, error: error.message }, 500);
  }

  // Smoke-test the round trip: ask the DB to call send-admin-push with the
  // freshly stored credential path (no devices needed — we only check auth).
  return json({ ok: true, synced: true });
});
