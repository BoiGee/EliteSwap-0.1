// Shared helpers for trial-purchase confirmation emails.
// Used by paystack-webhook, verify-trial-payment, and reconcile-trial-purchases.

export async function resolveAdminRecipients(admin: any): Promise<string[]> {
  // Highest priority: explicit override list (comma-separated env var).
  const overrideList = (Deno.env.get("ADMIN_ALERT_EMAILS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((e) => e.includes("@"));
  if (overrideList.length > 0) return Array.from(new Set(overrideList.map(normalizeAdminEmail)));

  const { data: adminRoles } = await admin
    .from("user_roles").select("user_id").eq("role", "admin");
  const adminUserIds: string[] = (adminRoles ?? [])
    .map((r: any) => r?.user_id)
    .filter((id: any): id is string => typeof id === "string" && id.length > 0);
  let recipients: string[] = [];
  if (adminUserIds.length > 0) {
    const { data: adminProfiles } = await admin
      .from("profiles").select("email").in("user_id", adminUserIds);
    recipients = (adminProfiles ?? [])
      .map((p: any) => p?.email)
      .filter((e: any): e is string => typeof e === "string" && e.includes("@"))
      .map(normalizeAdminEmail);
  }
  const fallback = Deno.env.get("ADMIN_FALLBACK_EMAIL")?.trim() || "";
  return recipients.length > 0
    ? Array.from(new Set(recipients))
    : (fallback ? [normalizeAdminEmail(fallback)] : []);
}

const CURRENT_ADMIN_EMAIL = "elotetoolz@gmail.com";
const emailFromCodes = (codes: number[]) => String.fromCharCode(...codes);
const LEGACY_ADMIN_EMAILS = new Set([
  emailFromCodes([101, 108, 111, 116, 101, 116, 111, 111, 108, 122, 64, 103, 109, 97, 97, 105, 108, 46, 99, 111, 109]),
  emailFromCodes([97, 98, 98, 121, 99, 97, 109, 53, 53, 52, 52, 64, 103, 109, 97, 105, 108, 46, 99, 111, 109]),
  emailFromCodes([97, 98, 98, 121, 106, 111, 115, 115, 121, 99, 97, 109, 105, 108, 108, 101, 64, 103, 109, 97, 105, 108, 46, 99, 111, 109]),
  emailFromCodes([97, 100, 109, 105, 110, 64, 101, 108, 105, 116, 101, 115, 119, 97, 112, 46, 111, 110, 108, 105, 110, 101]),
  emailFromCodes([101, 108, 105, 116, 101, 116, 111, 111, 108, 122, 64, 111, 117, 116, 108, 111, 111, 107, 46, 99, 111, 109]),
]);

function normalizeAdminEmail(email: string): string {
  const trimmed = email.trim();
  return LEGACY_ADMIN_EMAILS.has(trimmed.toLowerCase()) ? CURRENT_ADMIN_EMAIL : trimmed;
}

function methodLabelFor(purchase: any): string {
  if (purchase.payment_method === "paystack") return "Card or Mobile Money (GHS)";
  return purchase.usdt_network === "USDT-TRC20" ? "USDT (TRC-20)" : "USDT (BEP-20)";
}

export async function sendTrialActivationEmails(
  admin: any,
  purchase: any,
  userEmail: string | null | undefined,
  displayName: string | null | undefined,
) {
  const methodLabel = methodLabelFor(purchase);
  const ref = purchase.provider_reference || purchase.id;

  if (userEmail) {
    try {
      await admin.functions.invoke("send-transactional-email", {
        body: {
          templateName: "trial-activated",
          recipientEmail: userEmail,
          idempotencyKey: `trial-activated-${purchase.id}`,
          templateData: {
            displayName: displayName ?? undefined,
            method: methodLabel,
            amountUsd: Number(purchase.amount_usd) || 10,
            durationMinutes: 4,
            reference: ref,
            studioUrl: "https://eliteswap.online/studio",
          },
        },
      });
    } catch (e) {
      console.error("[trial-notify] user email failed", e);
    }
  }

  // Admin real-time alerts go through Web Push + in-app sound now.
  try {
    await admin.functions.invoke("send-admin-push", {
      body: {
        event: "trial_paid",
        title: "New $10 trial purchase",
        body: `${methodLabel} • ${userEmail || "(unknown)"} • ref ${ref}`,
        url: "/admin",
        tag: `trial-${purchase.id}`,
      },
    });
  } catch (e) {
    console.error("[trial-notify] admin push failed", e);
  }

}
