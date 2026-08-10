import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json({ code: "UNAUTHORIZED", message: "Sign in required" }, 401);
    }

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (userErr || !userData?.user) {
      return json({ code: "UNAUTHORIZED", message: "Invalid session" }, 401);
    }
    const callerId = userData.user.id;
    const callerEmail = userData.user.email ?? null;

    const body = await req.json().catch(() => ({}));
    const targetUserId: string = body.target_user_id || callerId;
    const notes: string | null = typeof body.notes === "string" ? body.notes.slice(0, 1000) : null;

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    let requestedBy: "self" | "admin" = "self";
    if (targetUserId !== callerId) {
      // Must be admin
      const { data: roleRow } = await admin
        .from("user_roles")
        .select("role")
        .eq("user_id", callerId)
        .eq("role", "admin")
        .maybeSingle();
      if (!roleRow) {
        return json({ code: "FORBIDDEN", message: "Admin role required" }, 403);
      }
      requestedBy = "admin";
    }

    // Fetch target email
    const { data: targetUser, error: tErr } = await admin.auth.admin.getUserById(targetUserId);
    if (tErr || !targetUser?.user) {
      return json({ code: "NOT_FOUND", message: "User not found" }, 404);
    }
    const targetEmail = targetUser.user.email ?? callerEmail;

    // Upsert deletion request
    const { error: upsertErr } = await admin
      .from("account_deletion_requests")
      .upsert(
        {
          user_id: targetUserId,
          email: targetEmail,
          requested_by: requestedBy,
          requested_at: new Date().toISOString(),
          purge_after: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          purged_at: null,
          cancelled_at: null,
          notes,
        },
        { onConflict: "user_id" },
      );
    if (upsertErr) {
      console.error("[request-account-deletion] upsert", upsertErr);
      return json({ code: "ERROR", message: "Could not record request" }, 500);
    }

    // Disable any pool API keys currently linked to this user
    const { data: userKeys } = await admin
      .from("api_keys")
      .select("pool_key_id")
      .eq("user_id", targetUserId)
      .not("pool_key_id", "is", null);
    const poolIds = (userKeys ?? []).map((k: any) => k.pool_key_id).filter(Boolean);
    if (poolIds.length) {
      await admin
        .from("api_key_pool")
        .update({ status: "disabled", assigned_to_user_id: null, assigned_payment_id: null })
        .in("id", poolIds);
    }
    // Deactivate user's api_keys to block studio access immediately
    await admin
      .from("api_keys")
      .update({ is_active: false })
      .eq("user_id", targetUserId);

    // Cancel any pending trial purchases so a late webhook / verifier cron
    // can't confirm them (and mint a key) during the 7-day grace window.
    await admin
      .from("trial_purchases")
      .update({ status: "failed" })
      .eq("user_id", targetUserId)
      .eq("status", "pending");

    // Ban the auth user for 168h (7 days). They'll be unable to sign in.
    const banResult = await admin.auth.admin.updateUserById(targetUserId, {
      ban_duration: "168h",
    } as any);
    if ((banResult as any)?.error) {
      console.error("[request-account-deletion] ban", (banResult as any).error);
    }

    admin.functions.invoke("send-admin-push", {
      body: {
        event: "account_deletion_requested",
        title: requestedBy === "admin"
          ? "Admin queued account deletion"
          : "User requested account deletion",
        body: `${targetEmail ?? targetUserId} • purges in 7d`,
        url: "/admin",
        tag: `deletion-${targetUserId}`,
      },
    }).catch((e) => console.warn("[request-account-deletion] push failed", e));


    return json({
      ok: true,
      purge_after: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      requested_by: requestedBy,
    });
  } catch (e) {
    console.error("[request-account-deletion] uncaught", e);
    return json({ code: "ERROR", message: "Unexpected error" }, 500);
  }
});
