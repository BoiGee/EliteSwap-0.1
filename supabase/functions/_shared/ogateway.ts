// OGateway (ogateway.io) client shared by create-plan-checkout, ogateway-webhook and
// verify-ogateway-payment.
//
// Secrets:
//   OGATEWAY_API_KEY    test_… / live_… key, sent as the Authorization header
//   OGATEWAY_SECRET     signs webhooks (HMAC-SHA512 of the raw body, hex, x-ogateway-signature)
//   OGATEWAY_TRANSPORT  "direct" (default) or "db": route calls through the database's fixed
//                       outbound IP (og_http_queue / og_http_result) if OGateway only accepts
//                       allow-listed addresses; edge functions have no fixed address.

const API = "https://api.ogateway.io";

export type OgStatus = "INITIATED" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED" | string;

export interface OgPayment {
  id: string;
  amount: string | number;
  currency: string;
  status: OgStatus;
  channel?: string;
  type?: string;
  provider_message?: string | null;
}

export class OgError extends Error {
  constructor(message: string, public status: number, public body: unknown) {
    super(message);
  }
}

function apiKey(): string {
  const k = Deno.env.get("OGATEWAY_API_KEY");
  if (!k) throw new OgError("OGateway is not configured", 503, null);
  return k;
}

async function viaDirect(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: apiKey(), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

// deno-lint-ignore no-explicit-any
async function viaDatabase(admin: any, method: string, path: string, body?: unknown) {
  const { data: id, error } = await admin.rpc("og_http_queue", {
    p_method: method, p_url: `${API}${path}`, p_auth: apiKey(), p_body: body ?? null,
  });
  if (error) throw new OgError(`relay queue failed: ${error.message}`, 502, null);
  // pg_net sends within a second or two of the queuing call committing.
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const { data } = await admin.rpc("og_http_result", { p_id: id });
    if (data) {
      if (data.error) throw new OgError(`relay error: ${data.error}`, 502, null);
      return { status: Number(data.status), text: String(data.body ?? "") };
    }
  }
  throw new OgError("OGateway did not answer in time", 504, null);
}

// deno-lint-ignore no-explicit-any
export async function ogRequest<T>(admin: any, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const useDb = (Deno.env.get("OGATEWAY_TRANSPORT") ?? "direct") === "db";
  const { status, text } = useDb ? await viaDatabase(admin, method, path, body) : await viaDirect(method, path, body);
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { /* HTML error page (e.g. a firewall 403) */ }
  if (status < 200 || status >= 300) {
    // deno-lint-ignore no-explicit-any
    const msg = (parsed as any)?.message;
    throw new OgError(
      Array.isArray(msg) ? msg.join("; ") : msg ?? `OGateway returned HTTP ${status}${parsed ? "" : " (blocked before reaching the API)"}`,
      status,
      parsed ?? text.slice(0, 300),
    );
  }
  return parsed as T;
}

// deno-lint-ignore no-explicit-any
export function createCheckout(admin: any, amountGhs: number, callbackURL: string) {
  return ogRequest<{ id: string; checkout_url: string }>(admin, "POST", "/collections/checkout", {
    amount: amountGhs,
    currency: "GHS",
    callbackURL,
    channels: ["MOMO", "CARD"],
  });
}

// deno-lint-ignore no-explicit-any
export function getPayment(admin: any, id: string) {
  return ogRequest<OgPayment>(admin, "GET", `/payments/${encodeURIComponent(id)}`);
}

function hex(buf: ArrayBuffer) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyWebhookSignature(rawBody: string, signature: string | null): Promise<boolean> {
  const secret = Deno.env.get("OGATEWAY_SECRET");
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const mac = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)));
  return timingSafeEqual(mac, signature.trim().toLowerCase());
}

// USD → GHS at the live mid-market rate (the same feed the site uses to show local prices).
export async function usdToGhsRate(): Promise<number> {
  const res = await fetch("https://open.er-api.com/v6/latest/USD");
  const j = await res.json().catch(() => null);
  const rate = Number(j?.rates?.GHS);
  if (!res.ok || !Number.isFinite(rate) || rate < 5 || rate > 50) {
    throw new OgError("Couldn't get today's cedi exchange rate. Please try again in a minute.", 503, j);
  }
  return rate;
}

export type SettleResult =
  | { state: "confirmed" }
  | { state: "already"; status: string }
  | { state: "pending"; ogStatus: string }
  | { state: "closed"; ogStatus: string }
  | { state: "mismatch"; reason: string };

// The single place an OGateway payment gets confirmed. Never trusts a webhook body or the
// browser: it reads the payment back from OGateway and checks status, currency and amount.
// deno-lint-ignore no-explicit-any
export async function settlePayment(admin: any, paymentId: string): Promise<SettleResult> {
  const { data: p, error } = await admin
    .from("payments")
    .select("id,user_id,status,payment_method,provider_reference,amount_local,amount_usd,plan_id,created_at")
    .eq("id", paymentId)
    .maybeSingle();
  if (error || !p) return { state: "mismatch", reason: "payment_not_found" };
  if (p.payment_method !== "ogateway" || !p.provider_reference) return { state: "mismatch", reason: "not_an_ogateway_payment" };
  if (p.status !== "pending") return { state: "already", status: p.status };

  const og = await getPayment(admin, p.provider_reference);
  const status = String(og.status ?? "").toUpperCase();

  if (status === "FAILED" || status === "CANCELLED") {
    await admin.rpc("close_gateway_payment", { p_payment_id: p.id });
    return { state: "closed", ogStatus: status };
  }
  if (status !== "COMPLETED") {
    // Abandoned checkouts are closed after a day so they don't sit as "pending" forever.
    if (Date.now() - new Date(p.created_at).getTime() > 24 * 3600_000) {
      await admin.rpc("close_gateway_payment", { p_payment_id: p.id });
      return { state: "closed", ogStatus: status || "EXPIRED" };
    }
    return { state: "pending", ogStatus: status };
  }

  const paid = Number(og.amount);
  if (String(og.currency).toUpperCase() !== "GHS") return { state: "mismatch", reason: `currency_${og.currency}` };
  if (!(paid + 0.01 >= Number(p.amount_local))) return { state: "mismatch", reason: `underpaid_${paid}_of_${p.amount_local}` };

  const { error: confErr } = await admin.rpc("auto_confirm_payment_from_verifier", { p_payment_id: p.id });
  if (confErr) {
    // Lost a race with the webhook / another check: someone else confirmed it first.
    const { data: again } = await admin.from("payments").select("status").eq("id", p.id).maybeSingle();
    if (again?.status === "confirmed") return { state: "already", status: "confirmed" };
    throw new OgError(`confirm failed: ${confErr.message}`, 500, null);
  }

  // Same follow-ups as the crypto verifier: admin alert and the customer's receipt email.
  try {
    await admin.functions.invoke("notify-admin-payment-event", { body: { paymentId: p.id, eventType: "auto_confirmed" } });
  } catch (e) { console.warn("[ogateway] admin notify failed", e); }
  try {
    const { data: prof } = await admin.from("profiles").select("email,display_name").eq("user_id", p.user_id).maybeSingle();
    if (prof?.email) {
      await admin.functions.invoke("send-transactional-email", {
        body: {
          templateName: "payment-approved",
          recipientEmail: prof.email,
          idempotencyKey: `payment-${p.id}-confirmed`,
          templateData: {
            displayName: prof.display_name || prof.email.split("@")[0],
            amountUsd: p.amount_usd,
            paymentMethod: og.channel === "CARD" ? "Card" : "Mobile Money",
            reference: p.provider_reference,
            adminNote: "Your payment went through and your unique key is ready in your dashboard.",
          },
        },
      });
    }
  } catch (e) { console.warn("[ogateway] receipt email failed", e); }

  return { state: "confirmed" };
}
