import { supabase } from "@/integrations/supabase/client";

export type AdminPaymentEvent =
  | "pending_review"
  | "auto_confirmed"
  | "admin_confirmed"
  | "admin_rejected";

export interface AdminAlertPayload {
  paymentId: string;
  eventType: AdminPaymentEvent;
  // Other fields are accepted for backward compatibility but ignored —
  // the server re-derives them from the trusted payment row.
  userEmail?: string | null;
  userDisplayName?: string | null;
  amountUsd?: number | null;
  currency?: string | null;
  planName?: string | null;
  paymentMethod?: string | null;
  reference?: string | null;
  discountCode?: string | null;
}

/**
 * Fire-and-forget admin email notification on payment events.
 * Goes through a server-side edge function that re-validates the caller
 * and the payment server-side; clients cannot forge fields.
 */
export function notifyAdminPaymentEvent(payload: AdminAlertPayload): void {
  void (async () => {
    try {
      await supabase.functions.invoke("notify-admin-payment-event", {
        body: {
          paymentId: payload.paymentId,
          eventType: payload.eventType,
        },
      });
    } catch (e) {
      // Silent: admin alerts must never break the UX.
      console.warn("[adminNotify] failed", e);
    }
  })();
}
