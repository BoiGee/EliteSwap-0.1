// Create a $10 trial purchase. Method = "usdt" or "momo_manual".
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const TRIAL_USD = 10;
const TRIAL_GHS = 150;
const MOMO_NUMBER = "0502657294";
const MOMO_NETWORK = "Telecel Cash";
const MOMO_NAME = "Linda Brakoh-Kwakyi";

const USDT_NETWORKS: Record<string, { label: string; network: string; address: string }> = {
  "USDT-BEP20": {
    label: "USDT (BEP-20)",
    network: "BNB Smart Chain (BEP-20)",
    address: "0x15a62f46355f03b66c30e88dad4564dd69a3aab7",
  },
  "USDT-TRC20": {
    label: "USDT (TRC20)",
    network: "Tron Network (TRC20)",
    address: "TMzkn5dm1Ehzg5KUF8uNcB1N9Y5FjzadF8",
  },
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

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
    const method = String(body?.method || "").toLowerCase();
    const network = String(body?.network || "USDT-BEP20");
    if (method !== "usdt" && method !== "momo_manual") {
      return json({ code: "BAD_REQUEST", message: "method must be 'usdt' or 'momo_manual'" }, 400);
    }

    const admin = createClient(SUPABASE_URL, SERVICE, {
      auth: { persistSession: false },
    });

    // enforce 2 lifetime cap (count confirmed-with-key + pending)
    const { data: existing } = await admin
      .from("trial_purchases")
      .select("id,status,assigned_key_id,created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    const confirmedAssigned =
      existing?.filter((p: any) => p.status === "confirmed" && p.assigned_key_id).length ?? 0;
    if (confirmedAssigned >= 2) {
      return json({ code: "LIMIT_REACHED", message: "You have used both trial sessions. Please choose a paid plan." }, 403);
    }

    // Reuse a fresh pending purchase of the same method if it's <30 min old
    const cutoff = Date.now() - 30 * 60 * 1000;
    const reuse = existing?.find(
      (p: any) =>
        p.status === "pending" &&
        p.payment_method === method &&
        new Date(p.created_at).getTime() > cutoff,
    );

    if (method === "usdt") {
      const net = USDT_NETWORKS[network] ?? USDT_NETWORKS["USDT-BEP20"];
      let purchaseId = reuse?.id;
      let isNew = false;
      if (!purchaseId) {
        const { data: ins, error: ie } = await admin
          .from("trial_purchases")
          .insert({
            user_id: userId,
            payment_method: "usdt",
            amount_usd: TRIAL_USD,
            amount_local: TRIAL_USD,
            currency: network,
            usdt_network: network,
            usdt_address: net.address,
            status: "pending",
          })
          .select("id")
          .single();
        if (ie) return json({ code: "ERROR", message: ie.message }, 500);
        purchaseId = ins.id;
        isNew = true;
      } else {
        await admin
          .from("trial_purchases")
          .update({ payment_method: "usdt", usdt_network: network, usdt_address: net.address, currency: network })
          .eq("id", purchaseId);
      }
      if (isNew) {
        admin.functions.invoke("send-admin-push", {
          body: {
            event: "pending_review",
            title: "New trial purchase started",
            body: `$${TRIAL_USD} • ${ud.user.email ?? "user"} • ${network}`,
            url: "/admin",
            tag: `trial-pending-${purchaseId}`,
          },
        }).catch((e) => console.warn("[create-trial-purchase] push failed", e));
      }
      return json({
        purchase_id: purchaseId,
        method: "usdt",
        network,
        label: net.label,
        address: net.address,
        amount_usdt: TRIAL_USD,
      });
    }

    // Manual Mobile Money (GHS) — fixed amount, provided number, user pastes
    // the transaction ID after sending. No automatic verification exists for
    // this path; every purchase is confirmed by an admin (needs_admin_review
    // gets set in verify-trial-payment once the reference is submitted).
    {
      let purchaseId = reuse?.id;
      let isNew = false;
      if (!purchaseId) {
        const { data: ins, error: ie } = await admin
          .from("trial_purchases")
          .insert({
            user_id: userId,
            payment_method: "momo_manual",
            amount_usd: TRIAL_USD,
            amount_local: TRIAL_GHS,
            currency: "GHS",
            status: "pending",
          })
          .select("id")
          .single();
        if (ie) return json({ code: "ERROR", message: ie.message }, 500);
        purchaseId = ins.id;
        isNew = true;
      }
      if (isNew) {
        admin.functions.invoke("send-admin-push", {
          body: {
            event: "pending_review",
            title: "New trial purchase started",
            body: `$${TRIAL_USD} • ${ud.user.email ?? "user"} • Momo (manual, GHS)`,
            url: "/admin",
            tag: `trial-pending-${purchaseId}`,
          },
        }).catch((e) => console.warn("[create-trial-purchase] push failed", e));
      }

      return json({
        purchase_id: purchaseId,
        method: "momo_manual",
        momo_number: MOMO_NUMBER,
        momo_network: MOMO_NETWORK,
        momo_name: MOMO_NAME,
        amount_ghs: TRIAL_GHS,
      });
    }
  } catch (e) {
    console.error("[create-trial-purchase] uncaught", e);
    return json({ code: "ERROR", message: "Unexpected error" }, 500);
  }
});
