// Where customers can message us directly (shown next to each other wherever help is offered).
// WhatsApp: international format, digits only. Empty = that button stays hidden.
export const SUPPORT_WHATSAPP = "233502657294"; // 050 265 7294
export const SUPPORT_TELEGRAM = "https://t.me/elitetoolz";

export function whatsappLink(message: string): string | null {
  if (!SUPPORT_WHATSAPP) return null;
  return `https://wa.me/${SUPPORT_WHATSAPP}?text=${encodeURIComponent(message)}`;
}

export function telegramLink(): string | null {
  return SUPPORT_TELEGRAM || null;
}

/** Fired to open the $10 trial checkout from anywhere on the dashboard (hero button, links). */
export const START_TRIAL_EVENT = "eliteswap:start-trial";
export function openTrialCheckout() {
  window.dispatchEvent(new Event(START_TRIAL_EVENT));
}
