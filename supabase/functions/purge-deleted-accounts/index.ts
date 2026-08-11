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

async function purgeUser(admin: any, userId: string, email: string | null) {
  // Disable pool keys associated with this user, never re-issue.
  const { data: userKeys } = await admin
    .from("api_keys").select("pool_key_id").eq("user_id", userId);
  const poolIds = (userKeys ?? []).map((k: any) => k.pool_key_id).filter(Boolean);
  if (poolIds.length) {
    await admin.from("api_key_pool")
      .update({ status: "disabled", assigned_to_user_id: null, assigned_payment_id: null })
      .in("id", poolIds);
  }

  // Forfeit any partner override earnings before wiping (preserve accounting on beneficiary side).
  // Source partner gets nulled out by deleting partners row below; override rows for beneficiaries stay.
  // No mutation needed here besides ensuring payments delete cascades.

  // Tables keyed by user_id — delete in dependency-safe order. Every
  // .delete().eq('user_id', ...) here is naturally idempotent (deleting an
  // already-empty set is a no-op), which is what makes it safe to retry
  // this whole function again on a later cron tick after a partial failure.
  const tables = [
    "studio_sessions",
    "free_trial_assignments",
    "payment_verification_attempts", // via payment join below
    "discount_redemptions",
    "payment_nudge_history",
    "api_keys",
    "partner_attributions",
    // support_messages has no user_id column (messages are keyed by
    // conversation_id + sender_id, not the ticket owner directly) — deleting
    // it here always errored. It doesn't need an explicit entry anyway:
    // support_messages.conversation_id -> support_conversations(id) is
    // ON DELETE CASCADE, so a user's own messages are removed automatically
    // the moment their support_conversations row is deleted below. Left
    // alone on purpose: messages this user sent as staff replying on a
    // DIFFERENT customer's ticket (sender_id, no FK) — deleting those would
    // rip content out of someone else's support history instead of this
    // user's own data.
    "support_internal_notes",
    "support_conversations",
    "reviews",
    "user_activity_logs",
    "terms_acceptances",
    "user_roles",
    "broadcast_recipients",
    "partners",
    "profiles",
  ];

  // payments is deliberately NOT in the delete list — per-decision, payment/
  // transaction records survive account deletion for accounting purposes.
  // payments.user_id is now ON DELETE SET NULL (was CASCADE), so the row is
  // automatically anonymized the moment auth.admin.deleteUser() runs below;
  // no explicit action needed here. This also means partner_override_earnings
  // tied to this payment (if it ever generated referral commission for
  // someone else) is no longer collateral damage — its parent payment row
  // no longer gets deleted out from under it.

  // Delete payment_verification_attempts via payment ids first
  const { data: pays } = await admin.from("payments").select("id").eq("user_id", userId);
  const payIds = (pays ?? []).map((p: any) => p.id);
  if (payIds.length) {
    const { error } = await admin.from("payment_verification_attempts").delete().in("payment_id", payIds);
    if (error) console.warn(`[purge] payment_verification_attempts: ${error.message}`);
  }

  // Collect every failure instead of only logging it — previously a failed
  // delete on any of these tables (e.g. an FK constraint added later, or a
  // transient error) was swallowed by console.warn and the loop pressed on
  // regardless, still marking the request "purged" and still deleting the
  // auth login at the end. That leaves the row permanently unretriable
  // (purged_at is set, so the cron's WHERE purged_at IS NULL never picks it
  // up again) while some of the user's personal data silently survives —
  // exactly wrong for a "right to erasure" feature. Now: if anything here
  // fails, the auth user is NOT deleted and the request is NOT marked
  // purged, so it's simply retried in full on the next run.
  const tableErrors: { table: string; error: string }[] = [];
  for (const t of tables) {
    if (t === "payment_verification_attempts") continue;
    if (t === "support_internal_notes") {
      const { error } = await admin.from(t).delete().eq("author_id", userId);
      if (error) tableErrors.push({ table: t, error: error.message });
      continue;
    }
    const { error } = await admin.from(t).delete().eq("user_id", userId);
    if (error) tableErrors.push({ table: t, error: error.message });
  }

  if (email) {
    const { error: e1 } = await admin.from("email_send_log").delete().eq("recipient_email", email);
    if (e1) tableErrors.push({ table: "email_send_log", error: e1.message });
    const { error: e2 } = await admin.from("email_unsubscribe_tokens").delete().eq("email", email);
    if (e2) tableErrors.push({ table: "email_unsubscribe_tokens", error: e2.message });
  }

  if (tableErrors.length) {
    console.error(`[purge] ${userId}: incomplete, leaving request unmarked for retry`, tableErrors);
    return { ok: false, error: "Incomplete data cleanup — will retry", tableErrors };
  }

  // Only now — once every personal-data table is confirmed clear — remove
  // the auth login and mark the request purged. If deleteUser fails here,
  // the request is still left unmarked (not purged) so it retries too,
  // rather than leaving a "ghost" account with data gone but login intact.
  const { error: authErr } = await admin.auth.admin.deleteUser(userId);
  if (authErr) {
    console.error(`[purge] auth.deleteUser ${userId}: ${authErr.message}`);
    return { ok: false, error: authErr.message };
  }

  // mark purged instead of deleting the request row (kept for audit; a
  // separate 30-day housekeeping pass below hard-deletes old purged rows).
  await admin.from("account_deletion_requests")
    .update({ purged_at: new Date().toISOString() })
    .eq("user_id", userId);

  return { ok: true };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Determine caller context. Auth is REQUIRED for all invocations:
    //   - Cron path: pg_cron passes `Authorization: Bearer <SERVICE_ROLE_KEY>`.
    //   - Admin UI:  user JWT with admin role; may pass target_user_id for immediate purge.
    // Unauthenticated callers are rejected (prevents anyone on the internet from
    // triggering irreversible deletes on due rows).
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return json({ code: "UNAUTHORIZED" }, 401);
    }
    const token = authHeader.replace("Bearer ", "").trim();
    let isAdmin = false;
    let isServiceRole = false;

    if (token && token === SERVICE_KEY) {
      isServiceRole = true;
    } else {
      const { data: u, error: uErr } = await admin.auth.getUser(token);
      if (uErr || !u?.user) {
        return json({ code: "UNAUTHORIZED" }, 401);
      }
      const { data: roleRow } = await admin.from("user_roles")
        .select("role").eq("user_id", u.user.id).eq("role", "admin").maybeSingle();
      if (!roleRow) return json({ code: "FORBIDDEN" }, 403);
      isAdmin = true;
    }

    const body = await req.json().catch(() => ({}));
    const targetUserId: string | undefined = body?.target_user_id;

    if (targetUserId && !isAdmin) {
      return json({ code: "FORBIDDEN", message: "Admin required for targeted purge" }, 403);
    }
    // Suppress unused-var warning while preserving the explicit branch above.
    void isServiceRole;

    let query = admin
      .from("account_deletion_requests")
      .select("user_id, email, purge_after")
      .is("purged_at", null)
      .is("cancelled_at", null);
    if (targetUserId) {
      query = query.eq("user_id", targetUserId);
    } else {
      query = query.lte("purge_after", new Date().toISOString());
    }
    const { data: due, error } = await query;
    if (error) return json({ code: "ERROR", message: error.message }, 500);

    const results: any[] = [];
    for (const row of due ?? []) {
      const r = await purgeUser(admin, row.user_id, row.email);
      results.push({ user_id: row.user_id, ...r });
    }

    // Cron-only housekeeping: hard-delete audit rows older than 30d after purge.
    if (!targetUserId) {
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      await admin.from("account_deletion_requests")
        .delete()
        .not("purged_at", "is", null)
        .lt("purged_at", cutoff);
    }

    return json({ ok: true, purged: results.filter((r) => r.ok).length, results });
  } catch (e) {
    console.error("[purge-deleted-accounts]", e);
    return json({ code: "ERROR", message: "Unexpected" }, 500);
  }
});
