// Users only ever see Elite Swap in the studio, never the names of the services behind it.
// Errors from the video providers, their SDKs or older server builds can carry those names (or
// raw technical text), so anything user-facing that didn't originate in our own copy passes
// through brandMessage() first.

const PROVIDER_TERMS = /\b(vidu|shengshu|decart|lucy|aliyun|alirtc|artc|ali\s?rtc|agora|trtc|volcengine)\b/i;
// Raw protocol/SDK output ("code = 400 reason = BadRequest", "0x0102...", "AliRtcEngine ...").
const TECHNICAL_TEXT = /(code\s*=|reason\s*=|metadata\s*=|0x[0-9a-f]{4,}|\bErr(or)?Code\b|non-2xx|Engine\b|undefined|null\b)/i;

export function mentionsProvider(text: string): boolean {
  return PROVIDER_TERMS.test(text);
}

/** The message if it's safe to show as-is, otherwise the branded fallback. */
export function brandMessage(message: string | null | undefined, fallback: string): string {
  const m = (message ?? "").trim();
  if (!m || PROVIDER_TERMS.test(m) || TECHNICAL_TEXT.test(m)) return fallback;
  return m;
}
