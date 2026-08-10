import { supabase } from "@/integrations/supabase/client";

/**
 * Payment funnel stages — keep in sync with the DB trigger
 * `tg_update_payment_funnel_stage`. Higher number = further along.
 */
export const FUNNEL_STAGES = {
  NONE: 0,
  PRICING_VIEWED: 1,
  PLAN_SELECTED: 2,
  PAYMENT_METHOD_CHOSEN: 3,
  CRYPTO_QR_VIEWED: 4,
  CRYPTO_ADDRESS_COPIED: 5,
  TX_HASH_SUBMITTED: 6,
  PAYMENT_CONFIRMED: 8,
} as const;

export const FUNNEL_STAGE_LABELS: Record<number, string> = {
  0: "Not started",
  1: "Viewed pricing",
  2: "Selected a plan",
  3: "Chose payment method",
  4: "Saw crypto QR / payment screen",
  5: "Copied crypto address",
  6: "Submitted tx hash",
  8: "Payment confirmed ✅",
};

export type FunnelAction =
  | "funnel_pricing_viewed"
  | "funnel_plan_selected"
  | "funnel_payment_method_chosen"
  | "funnel_crypto_qr_viewed"
  | "funnel_crypto_address_copied"
  | "funnel_tx_hash_submitted"
  | "funnel_payment_confirmed";

/**
 * Fire-and-forget funnel checkpoint. Inserts an activity log row that the DB
 * trigger uses to bump the user's furthest reached stage. Silent on failure
 * so it never blocks the UX.
 */
export async function trackFunnel(
  action: FunnelAction,
  metadata?: Record<string, string | number | boolean | null>
) {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    void supabase.from("user_activity_logs").insert([{
      user_id: user.id,
      action,
      page: typeof window !== "undefined" ? window.location.pathname : null,
      metadata: (metadata || {}) as never,
    }]).then(() => {}, () => {});
  } catch {
    // silent
  }
}
