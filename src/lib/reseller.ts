import { supabase } from "@/integrations/supabase/client";

// Reseller program (see supabase/migrations/20261115120000_reseller_program.sql).
// A reseller sells plans to his own customers at his own prices; Elite Swap takes the list price
// plus half his markup on each sale, debited from his prepaid balance.

// The generated client types (integrations/supabase/types.ts) predate the reseller tables and
// functions, so they go through this one untyped handle; results are cast at each call site.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const untyped = supabase as any;
export type RpcError = { message: string } | null;
export const rpc = <T = unknown>(fn: string, args?: Record<string, unknown>): Promise<{ data: T | null; error: RpcError }> =>
  untyped.rpc(fn, args);
export const fromTable = (table: string) => untyped.from(table);

export interface StorefrontPlan {
  plan_id: string;
  name: string;
  description: string | null;
  features: string[] | null;
  minutes: number;
  monthly_price_usd: number | null;
  annual_price_usd: number | null;
}

export interface Storefront {
  code: string;
  display_name: string;
  contact: string | null;
  plans: StorefrontPlan[];
}

export interface ResellerPurchase {
  payment_id: string;
  plan_name: string;
  billing_period: "monthly" | "annual";
  price_usd: number;
  reseller_name: string;
  created_at: string;
}

export const fmtUsd = (n: number | null | undefined) =>
  n == null ? "—" : `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Elite Swap's share of a sale: the list price plus half the reseller's markup. Same rounding as
 * reseller_record_sale() (a half cent goes to Elite Swap), worked in whole cents so the preview
 * never drifts from what the server charges.
 */
export function splitSale(listUsd: number, priceUsd: number) {
  const list = Math.round(listUsd * 100);
  const price = Math.round(priceUsd * 100);
  const platform = list + Math.round((price - list) / 2);
  return { platform: platform / 100, reseller: (price - platform) / 100 };
}

export function resellerLink(code: string) {
  return `${window.location.origin}/r/${encodeURIComponent(code)}`;
}

// ---------------------------------------------------------------- link capture
// /r/:code stores the code; it's attached once the visitor is signed in (signup needs email
// confirmation first, so the dashboard retries on load).

const KEY = "pending_reseller_code";

export function setPendingResellerCode(code: string) {
  try {
    localStorage.setItem(KEY, code.trim().toUpperCase());
  } catch {
    /* noop */
  }
}

export function getPendingResellerCode(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function clearPendingResellerCode() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* noop */
  }
}

export type AttachResellerResult = {
  ok: boolean;
  reason?: "invalid_code" | "already_linked" | "is_reseller" | "has_partner" | "existing_customer" | "error";
  reseller_name?: string;
  code?: string;
};

export function attachResellerMessage(r: AttachResellerResult): { title: string; description?: string } | null {
  if (r.ok) return { title: `You're now buying through ${r.reseller_name}`, description: "They'll sell you minutes and your key appears in Step 2." };
  switch (r.reason) {
    case "already_linked": return { title: "Already linked", description: `Your account already buys through ${r.reseller_name}.` };
    case "has_partner": return { title: "Couldn't link this reseller", description: "Your account was referred by a partner, so it buys from Elite Swap directly." };
    case "existing_customer": return { title: "Couldn't link this reseller", description: "Your account already buys plans from Elite Swap directly. Contact support if you want to switch." };
    case "is_reseller": return { title: "You're a reseller", description: "A reseller account can't buy through another reseller." };
    case "invalid_code": return { title: "Reseller not found", description: "That reseller link isn't active." };
    default: return null;
  }
}

/** Attach the code saved from a /r/:code visit. Keeps it for a retry only on network errors. */
export async function attachPendingResellerCode(): Promise<AttachResellerResult | null> {
  const code = getPendingResellerCode();
  if (!code) return null;
  const { data, error } = await rpc("attach_reseller_code", { p_code: code, p_source: "link" });
  if (error) return { ok: false, reason: "error" };
  clearPendingResellerCode();
  return data as AttachResellerResult;
}

export async function attachResellerCodeManual(code: string): Promise<AttachResellerResult> {
  const { data, error } = await rpc("attach_reseller_code", { p_code: code.trim().toUpperCase(), p_source: "code" });
  if (error) return { ok: false, reason: "error" };
  clearPendingResellerCode();
  return data as AttachResellerResult;
}

/** Turn a Postgres exception from the reseller functions into its message (they're written for users). */
export function rpcErrorMessage(error: { message?: string } | null | undefined, fallback = "Something went wrong") {
  const m = error?.message?.trim();
  return m && m.length < 300 ? m : fallback;
}
