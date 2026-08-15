// Establishes cross-origin isolation on the /studio route so MediaPipe's
// threaded WASM segmenter (background replacement without a physical green
// screen) can use SharedArrayBuffer. GitHub Pages has no way to send the
// required COOP/COEP response headers itself, so public/sw.js injects them
// client-side — but a page is only ever isolated from the load *after* its
// controlling service worker activated, never the load that registered it.
// That's why this reloads exactly once: without it, the worker would install
// successfully and still report crossOriginIsolated === false forever.
import { isPreviewOrDev } from "@/lib/adminPush";

const RELOAD_GUARD_KEY = "elite-coi-reload-attempted";

export function ensureStudioCrossOriginIsolation(): void {
  if (typeof window === "undefined") return;
  if (window.crossOriginIsolated) return;
  if (!("serviceWorker" in navigator)) return;
  if (isPreviewOrDev()) return;
  // localStorage (not sessionStorage) so this is shared across every tab in
  // the browser, not just the current one — once any tab has done the
  // isolation-bootstrap reload, the service worker is active for the whole
  // origin and later tabs should already load pre-isolated. Worst case if a
  // later tab genuinely isn't isolated (e.g. its navigation raced SW
  // activation), it just falls back to chroma-key-only like any unsupported
  // browser, rather than paying another visible reload for it.
  if (localStorage.getItem(RELOAD_GUARD_KEY) === "1") return;

  navigator.serviceWorker
    .register("/sw.js", { scope: "/" })
    .then(() => navigator.serviceWorker.ready)
    .then(() => {
      localStorage.setItem(RELOAD_GUARD_KEY, "1");
      window.location.reload();
    })
    .catch((e) => {
      console.warn("[crossOriginIsolation] SW register failed", e);
    });
}
