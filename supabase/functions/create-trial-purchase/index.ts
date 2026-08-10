// Create a $10 trial purchase. Method = "usdt" or "paystack".
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const TRIAL_USD = 10;

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

async function fetchGhsRate(): Promise<number> {
  try {
    const r = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=ghs",
    );
    const j = await r.json();
    const v = Number(j?.["usd-coin"]?.ghs);
    if (v > 0) return v;
  } catch { /* ignore */ }
  return 15;
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
    const method = String(body?.method || "").toLowerCase();
    const network = String(body?.network || "USDT-BEP20");
    if (method !== "usdt" && method !== "paystack") {
      return json({ code: "BAD_REQUEST", message: "method must be 'usdt' or 'paystack'" }, 400);
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

    // Paystack
    const PAYSTACK_SECRET = Deno.env.get("PAYSTACK_SECRET_KEY");
    if (!PAYSTACK_SECRET) {
      return json({ code: "MISCONFIG", message: "Paystack not configured" }, 500);
    }
    const ghsRate = await fetchGhsRate();
    const ghsAmount = Math.round(TRIAL_USD * ghsRate * 100) / 100;
    const pesewas = Math.round(ghsAmount * 100);

    const ALLOWED_ORIGINS = new Set([
      "https://eliteswap.online",
      "https://www.eliteswap.online",
    ]);
    const rawOrigin = (req.headers.get("origin") || "").replace(/\/+$/, "");
    const safeOrigin = ALLOWED_ORIGINS.has(rawOrigin) ? rawOrigin : "https://eliteswap.online";
    const callbackUrl = `${safeOrigin}/dashboard?paystack_trial=1`;

    const initRes = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: ud.user.email,
        amount: pesewas,
        currency: "GHS",
        callback_url: callbackUrl,
        metadata: { user_id: userId, purpose: "trial", trial_usd: TRIAL_USD },
      }),
    });
    const initJson = await initRes.json();
    if (!initRes.ok || !initJson?.status) {
      console.error("paystack init failed", initJson);
      return json({ code: "PAYSTACK_ERROR", message: initJson?.message || "Could not initialize payment" }, 502);
    }
    const reference = initJson.data.reference as string;
    const authorization_url = initJson.data.authorization_url as string;

    const { data: ins, error: ie } = await admin
      .from("trial_purchases")
      .insert({
        user_id: userId,
        payment_method: "paystack",
        amount_usd: TRIAL_USD,
        amount_local: ghsAmount,
        currency: "GHS",
        provider_reference: reference,
        paystack_authorization_url: authorization_url,
        status: "pending",
      })
      .select("id")
      .single();
    if (ie) return json({ code: "ERROR", message: ie.message }, 500);

    admin.functions.invoke("send-admin-push", {
      body: {
        event: "pending_review",
        title: "New trial purchase started",
        body: `$${TRIAL_USD} • ${ud.user.email ?? "user"} • Paystack (GHS)`,
        url: "/admin",
        tag: `trial-pending-${ins.id}`,
      },
    }).catch((e) => console.warn("[create-trial-purchase] push failed", e));


    return json({
      purchase_id: ins.id,
      method: "paystack",
      authorization_url,
      reference,
      amount_ghs: ghsAmount,
    });
  } catch (e) {
    console.error("[create-trial-purchase] uncaught", e);
    return json({ code: "ERROR", message: "Unexpected error" }, 500);
  }
});
