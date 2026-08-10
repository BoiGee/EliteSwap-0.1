// Authenticated wrapper that lets end-users trigger a Web Push to admins for
// a small whitelist of user-generated events (support messages, forum reports).
// The caller must be signed in. All payload text is derived server-side from
// the caller's own row and a fixed title map — the client cannot inject
// arbitrary push copy.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type EventKind = "support_message" | "forum_report" | "review";

const TITLES: Record<EventKind, string> = {
  support_message: "New support message",
  forum_report: "New forum report",
  review: "New review submitted",
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
  if (!bearer) return json({ error: "Unauthorized" }, 401);

  const userClient = createClient(SUPABASE_URL, ANON, {
    global: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  const { data: claims, error: cErr } = await userClient.auth.getClaims(bearer);
  if (cErr || !claims?.claims?.sub) return json({ error: "Unauthorized" }, 401);
  const callerId = claims.claims.sub as string;

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const event: EventKind = body?.event;
  if (event !== "support_message" && event !== "forum_report" && event !== "review") {
    return json({ error: "Invalid event" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

  // Server-side compose the push body from the caller's identity + minimal
  // event context. We never trust user-supplied title/body strings.
  const { data: prof } = await admin
    .from("profiles")
    .select("email, display_name")
    .eq("user_id", callerId)
    .maybeSingle();
  const who = prof?.display_name || prof?.email || "a user";

  let pushBody = who;
  let url = "/admin";
  let tag = `${event}-${callerId}`;

  if (event === "support_message") {
    const messageId = typeof body?.messageId === "string" ? body.messageId : null;
    if (messageId) {
      const { data: msg } = await admin
        .from("support_messages")
        .select("id, sender_id, is_admin, content, conversation_id")
        .eq("id", messageId)
        .maybeSingle();
      // Only notify for messages the caller actually sent, and never for admin replies.
      if (!msg || msg.sender_id !== callerId || msg.is_admin) {
        return json({ ok: true, skipped: "not_user_message" });
      }
      const snippet = (msg.content ?? "").slice(0, 80);
      pushBody = `${who}: ${snippet || "(attachment)"}`;
      tag = `support-${msg.conversation_id}`;
    }
    url = "/admin?tab=support";
  } else if (event === "forum_report") {
    const reportId = typeof body?.reportId === "string" ? body.reportId : null;
    if (reportId) {
      const { data: rep } = await admin
        .from("forum_reports")
        .select("id, reporter_id, reason, target_kind")
        .eq("id", reportId)
        .maybeSingle();
      if (!rep || rep.reporter_id !== callerId) {
        return json({ ok: true, skipped: "not_reporter" });
      }
      pushBody = `${who} reported a ${rep.target_kind} — ${rep.reason}`;
      tag = `report-${rep.id}`;
    }
    url = "/admin?tab=forum";
  } else if (event === "review") {
    const reviewId = typeof body?.reviewId === "string" ? body.reviewId : null;
    if (reviewId) {
      const { data: rev } = await admin
        .from("reviews")
        .select("id, user_id, rating, remark, display_name")
        .eq("id", reviewId)
        .maybeSingle();
      if (!rev || rev.user_id !== callerId) {
        return json({ ok: true, skipped: "not_reviewer" });
      }
      const snippet = (rev.remark ?? "").slice(0, 80);
      const name = rev.display_name || who;
      pushBody = `⭐${rev.rating} — ${name}${snippet ? `: ${snippet}` : ""}`;
      tag = `review-${rev.id}`;
    }
    url = "/admin?tab=reviews";
  }

  try {
    await admin.functions.invoke("send-admin-push", {
      body: {
        event,
        title: TITLES[event],
        body: pushBody,
        url,
        tag,
      },
    });
  } catch (e) {
    console.warn("[notify-admin-event] push failed", e);
    return json({ ok: false, error: String(e) }, 200);
  }

  return json({ ok: true });
});
