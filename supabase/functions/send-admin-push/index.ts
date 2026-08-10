// Sends a Web Push notification to every admin device that has subscribed.
// Called by other edge functions (notify-admin-payment-event, trial-notify,
// etc.) via `admin.functions.invoke("send-admin-push", { body: ... })`.
//
// Payload:
//   { event: string, title: string, body: string, url?: string, tag?: string }
//
// Auth: service-role only. We reject everything else so users can't spam
// admin devices.

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@eliteswap.online";

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // service-role only
  const authHeader = req.headers.get("Authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (bearer !== serviceKey) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.warn("[send-admin-push] VAPID keys missing");
    return new Response(JSON.stringify({ skipped: "no_vapid" }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: any;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const { event, title, body: msgBody, url, tag } = body ?? {};
  if (!event || !title) {
    return new Response(JSON.stringify({ error: "event and title required" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const admin = createClient(supabaseUrl, serviceKey);

  // Find admin/mod/sec_admin user IDs
  const { data: roles } = await admin
    .from("user_roles")
    .select("user_id, role")
    .in("role", ["admin", "moderator"]);
  const userIds = Array.from(new Set((roles ?? []).map((r: any) => r.user_id).filter(Boolean)));
  if (userIds.length === 0) {
    return new Response(JSON.stringify({ sent: 0, skipped: "no_admins" }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { data: subs } = await admin
    .from("admin_push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .in("user_id", userIds);

  if (!subs || subs.length === 0) {
    return new Response(JSON.stringify({ sent: 0, skipped: "no_subs" }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const payload = JSON.stringify({
    event, title, body: msgBody ?? "", url: url ?? "/admin", tag: tag ?? event,
  });

  let sent = 0;
  let removed = 0;
  await Promise.all(subs.map(async (s: any) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: 60 * 60 * 24 },
      );
      sent++;
      await admin.from("admin_push_subscriptions")
        .update({ last_success_at: new Date().toISOString(), failure_count: 0 })
        .eq("id", s.id);
    } catch (e: any) {
      const status = e?.statusCode ?? 0;
      if (status === 404 || status === 410) {
        await admin.from("admin_push_subscriptions").delete().eq("id", s.id);
        removed++;
      } else {
        console.warn("[send-admin-push] send failed", status, e?.body ?? e?.message);
        // increment failure_count
        const { data: cur } = await admin.from("admin_push_subscriptions")
          .select("failure_count").eq("id", s.id).maybeSingle();
        const next = (cur?.failure_count ?? 0) + 1;
        if (next >= 5) {
          await admin.from("admin_push_subscriptions").delete().eq("id", s.id);
          removed++;
        } else {
          await admin.from("admin_push_subscriptions")
            .update({ failure_count: next }).eq("id", s.id);
        }
      }
    }
  }));

  return new Response(JSON.stringify({ sent, removed, total: subs.length }), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
