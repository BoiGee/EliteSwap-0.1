const IDENTITY_LOCK_SUFFIX =
  ", preserve reference face identity, keep the same hairstyle and hair color as the reference image, keep the same outfit and clothing as the reference image, stable facial features, no morphing, no clothing change";

const NEGATIVE_PROMPT_SUFFIX =
  ", avoid extra limbs, avoid extra fingers, avoid extra faces, avoid duplicate faces, avoid distorted anatomy, avoid warped eyes, avoid crossed eyes, avoid melting features, avoid text, avoid watermark, avoid logo, avoid nudity, avoid nsfw, avoid blurry output, avoid low quality, avoid glitch artifacts, avoid flickering, avoid background people, avoid ghosting";

const MAX_LUCY_PROMPT_LENGTH = 2200;

export function sanitizePromptForLucy(prompt?: string): string {
  const base = (prompt ?? "").trim();
  if (!base) return "Enhance the video slightly";

  const normalized = base.replace(/\s+/g, " ").trim();
  if (normalized.length > MAX_LUCY_PROMPT_LENGTH) {
    return `${normalized.slice(0, MAX_LUCY_PROMPT_LENGTH - 3).trimEnd()}...`;
  }
  return normalized;
}

export function buildPromptWithIdentityGuard(prompt?: string): string {
  const safePrompt = sanitizePromptForLucy(prompt);
  // Each suffix is checked and appended independently — a prompt that
  // already mentions "avoid extra limbs" but not the identity phrase (or
  // vice versa) used to get the whole block re-appended as one unit,
  // duplicating whichever half was already present.
  const hasIdentityGuard = safePrompt.includes("preserve reference face identity");
  const hasNegativeGuard = safePrompt.includes("avoid extra limbs");
  return `${safePrompt}${hasIdentityGuard ? "" : IDENTITY_LOCK_SUFFIX}${hasNegativeGuard ? "" : NEGATIVE_PROMPT_SUFFIX}`;
}
