import { supabase } from "@/integrations/supabase/client";

const KEY = "pending_partner_code";

export type AttachResult = {
  ok: boolean;
  reason?: "already_attributed" | "invalid_code" | "self_referral" | "empty" | "error";
  partner_code?: string;
  existing_code?: string;
};

export function capturePartnerCodeFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    const ref = params.get("ref");
    if (ref && ref.trim().length > 0) {
      localStorage.setItem(KEY, ref.trim().toUpperCase());
    }
  } catch {
    /* noop */
  }
}

export function getPendingPartnerCode(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function clearPendingPartnerCode() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* noop */
  }
}

/**
 * Best-effort attach. Always clears the pending code on a definitive RPC response
 * (success OR a non-retryable failure such as already_attributed/invalid_code/self_referral),
 * so the user can never accidentally re-attach across sessions.
 */
export async function attachPendingPartnerCode(
  source: "link" | "signup_code" | "dashboard_code" = "link"
): Promise<{ attempted: boolean; result?: AttachResult }> {
  const code = getPendingPartnerCode();
  if (!code) return { attempted: false };
  const { data, error } = await supabase.rpc("attach_partner_code" as any, {
    p_code: code,
    p_source: source,
  });
  if (error) {
    // Network / unexpected error — keep the code and try again later.
    return { attempted: true, result: { ok: false, reason: "error" } };
  }
  // Definitive answer received — burn the pending code regardless of outcome.
  clearPendingPartnerCode();
  return { attempted: true, result: data as AttachResult };
}

export async function attachPartnerCodeManual(code: string): Promise<AttachResult> {
  const trimmed = code.trim().toUpperCase();
  if (!trimmed) return { ok: false, reason: "empty" };
  const { data, error } = await supabase.rpc("attach_partner_code" as any, {
    p_code: trimmed,
    p_source: "dashboard_code",
  });
  if (error) return { ok: false, reason: "error" };
  // Once we have a definitive answer, also burn any pending code to be safe.
  clearPendingPartnerCode();
  return data as AttachResult;
}
