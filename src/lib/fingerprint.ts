import FingerprintJS from "@fingerprintjs/fingerprintjs";

const STORAGE_KEY = "es_fp_v1";
const FALLBACK_KEY = "es_fp_fallback_v1";
const FP_TIMEOUT_MS = 5000;

let agentPromise: ReturnType<typeof FingerprintJS.load> | null = null;

const getAgent = () => {
  if (!agentPromise) {
    agentPromise = FingerprintJS.load();
  }
  return agentPromise;
};

const timeout = <T>(ms: number): Promise<T> =>
  new Promise((_, reject) => setTimeout(() => reject(new Error("fingerprint_timeout")), ms));

const getOrCreateFallbackId = (): string => {
  try {
    const existing = localStorage.getItem(FALLBACK_KEY);
    if (existing && existing.length >= 8) return existing;
  } catch {
    /* ignore */
  }
  // Stable random fallback ID — 32 hex chars, prefixed for visibility.
  let id = "fb_";
  try {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    id += Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    id += Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
  try {
    localStorage.setItem(FALLBACK_KEY, id);
  } catch {
    /* ignore */
  }
  return id;
};

/**
 * Returns a stable visitor ID for the current device/browser.
 * Cached in localStorage; survives reloads. Used for trial-abuse prevention.
 *
 * GUARANTEE: Always resolves within ~5 seconds. If FingerprintJS is blocked
 * (ad-blockers, network) or hangs, returns a stable fallback ID instead so
 * downstream callers never deadlock.
 */
export async function getDeviceFingerprint(): Promise<string> {
  try {
    const cached = localStorage.getItem(STORAGE_KEY);
    if (cached && cached.length >= 8) return cached;
  } catch {
    /* localStorage unavailable */
  }

  try {
    const visitorId = await Promise.race<string>([
      (async () => {
        const fp = await getAgent();
        const result = await fp.get();
        return result.visitorId;
      })(),
      timeout<string>(FP_TIMEOUT_MS),
    ]);

    if (visitorId && visitorId.length >= 8) {
      try {
        localStorage.setItem(STORAGE_KEY, visitorId);
      } catch {
        /* ignore */
      }
      return visitorId;
    }
    // empty/short — fall through to fallback
    return getOrCreateFallbackId();
  } catch (err) {
    // Timed out, blocked, or threw — use stable fallback so the caller can proceed.
    console.warn("[fingerprint] using fallback id:", (err as Error)?.message);
    return getOrCreateFallbackId();
  }
}
