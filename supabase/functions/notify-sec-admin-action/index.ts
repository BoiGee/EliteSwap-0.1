// Fan-out for Sec Admin actions: pushes a rich notification to every admin
// device and mirrors the event into app_notifications so admins see it in the
// in-app bell too. Called from the `log_admin_action` DB function via pg_net
// whenever the actor is a sec_admin (and not also an admin).
//
// Service-role only — rejects anything else so users can't spam admin devices.

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const authHeader = req.headers.get("Authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (bearer !== serviceKey) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: any;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const {
    action,
    targetType,
    targetId,
    actorEmail,
    beforeData,
    afterData,
    metadata,
  } = body ?? {};

  if (!action || !targetType) {
    return new Response(JSON.stringify({ error: "action and targetType required" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const admin = createClient(supabaseUrl, serviceKey);

  // Build a rich human-readable body.
  const before = beforeData ?? {};
  const after = afterData ?? {};
  let summary = "";
  if (targetType === "payments") {
    const amt = after.amount_usd ?? before.amount_usd;
    const amtLabel = amt != null ? `$${amt}` : "";
    if (action.startsWith("payments.status.")) {
      const newStatus = action.replace("payments.status.", "");
      summary = `${amtLabel} → ${newStatus}`.trim();
    } else if (action === "payments.create") {
      summary = `Created ${amtLabel} payment`;
    } else if (action === "payments.update") {
      summary = `Updated ${amtLabel} payment`;
    } else if (action === "payments.delete") {
      summary = `Deleted ${amtLabel} payment`;
    }
    // Try to name the target user.
    const targetUserId = after.user_id ?? before.user_id;
    if (targetUserId) {
      const { data: prof } = await admin
        .from("profiles").select("email").eq("user_id", targetUserId).maybeSingle();
      if (prof?.email) summary += ` for ${prof.email}`;
    }
  } else if (targetType === "discount_codes") {
    const code = after.code ?? before.code ?? "";
    const pct = after.percent_off ?? before.percent_off;
    summary = `${code}${pct != null ? ` (${pct}%)` : ""}`;
  } else if (targetType === "user_roles") {
    const role = after.role ?? before.role;
    summary = `role: ${role}`;
  } else {
    summary = action;
  }

  const title = `Sec Admin: ${action.replace(/\./g, " · ")}`;
  const msgBody = `${actorEmail ?? "sec_admin"} → ${summary}`.trim();

  // Fire the push fan-out.
  try {
    await admin.functions.invoke("send-admin-push", {
      body: {
        event: `sec_admin.${action}`,
        title,
        body: msgBody,
        url: "/admin?tab=audit",
        tag: `sec-admin-${targetType}-${targetId ?? "x"}`,
      },
    });
  } catch (e) {
    console.warn("[notify-sec-admin-action] push failed", e);
  }

  // Mirror into app_notifications for every full admin so it shows in the bell.
  try {
    const { data: adminRoles } = await admin
      .from("user_roles").select("user_id").eq("role", "admin");
    const adminIds = Array.from(new Set((adminRoles ?? []).map((r: any) => r.user_id).filter(Boolean)));
    if (adminIds.length > 0) {
      const rows = adminIds.map((uid) => ({
        user_id: uid,
        title,
        body: msgBody,
        href: "/admin?tab=audit",
        kind: "sec_admin_action",
        metadata: metadata ?? {},
      }));
      await admin.from("app_notifications").insert(rows);
    }
  } catch (e) {
    console.warn("[notify-sec-admin-action] app_notifications insert failed", e);
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
