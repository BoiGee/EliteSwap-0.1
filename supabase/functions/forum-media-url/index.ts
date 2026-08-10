// Returns a short-lived signed URL for a forum_media row.
// Authorization:
//   - Caller must be authenticated.
//   - Owner of the media: always allowed.
//   - Admin: always allowed.
//   - Otherwise: media must be 'approved' AND caller must pass
//     forum_can_view_category() for the media's parent thread category.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const admin = createClient(url, serviceKey);

    const { media_id } = await req.json().catch(() => ({}));
    if (!media_id) {
      return new Response(JSON.stringify({ error: "media_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: media, error } = await admin
      .from("forum_media")
      .select("id, owner_id, storage_path, status, kind, mime, thread_id, reply_id")
      .eq("id", media_id)
      .maybeSingle();
    if (error || !media) {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Always require an authenticated caller for signed URLs.
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let authorized = false;

    // Owner short-circuit
    if (user.id === media.owner_id) {
      authorized = true;
    } else {
      // Admin short-circuit
      const { data: role } = await admin
        .from("user_roles")
        .select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle();
      if (role) authorized = true;
    }

    // For everyone else, require approved status AND category visibility.
    if (!authorized && media.status === "approved") {
      // Resolve parent thread (media may attach to a reply).
      let threadId: string | null = media.thread_id ?? null;
      if (!threadId && media.reply_id) {
        const { data: reply } = await admin
          .from("forum_replies")
          .select("thread_id")
          .eq("id", media.reply_id)
          .maybeSingle();
        threadId = reply?.thread_id ?? null;
      }
      if (threadId) {
        const { data: thread } = await admin
          .from("forum_threads")
          .select("category_id")
          .eq("id", threadId)
          .maybeSingle();
        const categoryId = thread?.category_id ?? null;
        if (categoryId) {
          const { data: canView, error: rpcErr } = await userClient.rpc(
            "forum_can_view_category",
            { _category_id: categoryId },
          );
          if (!rpcErr && canView === true) authorized = true;
        }
      }
    }

    if (!authorized) {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: signed, error: signErr } = await admin.storage
      .from("forum-media")
      .createSignedUrl(media.storage_path, 60 * 30);
    if (signErr || !signed) {
      return new Response(JSON.stringify({ error: signErr?.message || "sign failed" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      url: signed.signedUrl,
      kind: media.kind,
      mime: media.mime,
      status: media.status,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message ?? e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
