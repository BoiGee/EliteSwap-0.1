// "Go live" settings: Vidu relays the swapped output straight to the user's own streaming
// platform over RTMP (Vidu's `rtmp_urls` create parameter). Vidu takes plain rtmp:// only, so
// RTMPS-only platforms (Facebook, Kick) still need OBS. Settings stay on this device.

export type GoLivePlatform = "youtube" | "twitch" | "tiktok" | "custom";

export interface GoLiveSettings {
  enabled: boolean;
  platform: GoLivePlatform;
  server: string;
  streamKey: string;
}

export const GO_LIVE_PLATFORMS: Record<GoLivePlatform, { label: string; server: string; serverHint: string; keyHint: string }> = {
  youtube: {
    label: "YouTube",
    server: "rtmp://a.rtmp.youtube.com/live2",
    serverHint: "YouTube Studio → Create → Go live → Stream",
    keyHint: "Stream key from YouTube Studio",
  },
  twitch: {
    label: "Twitch",
    // Twitch's "Default" entry in https://ingest.twitch.tv/ingests (checked 2026-11-18).
    server: "rtmp://ingest.global-contribute.live-video.net/app",
    serverHint: "Twitch's automatic (nearest) ingest server",
    keyHint: "Creator Dashboard → Settings → Stream → Primary stream key",
  },
  tiktok: {
    label: "TikTok",
    server: "",
    serverHint: "TikTok LIVE Producer → Server URL (changes each stream)",
    keyHint: "TikTok LIVE Producer → Stream key",
  },
  custom: {
    label: "Other",
    server: "",
    serverHint: "Your platform's rtmp:// server URL",
    keyHint: "Stream key",
  },
};

const STORAGE_KEY = "eliteswap-golive";
const DEFAULTS: GoLiveSettings = { enabled: false, platform: "youtube", server: GO_LIVE_PLATFORMS.youtube.server, streamKey: "" };

export function loadGoLiveSettings(): GoLiveSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && typeof s === "object" && s.platform in GO_LIVE_PLATFORMS) return { ...DEFAULTS, ...s };
    }
  } catch { /* storage unavailable */ }
  return DEFAULTS;
}

export function saveGoLiveSettings(s: GoLiveSettings) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

/** Problem with the settings, or null when they can be sent. */
export function goLiveProblem(s: GoLiveSettings): string | null {
  const server = s.server.trim();
  if (!server) return "Add your streaming server URL.";
  if (/^rtmps:\/\//i.test(server)) return "This server needs RTMPS, which direct streaming doesn't support yet. Use OBS for this platform.";
  if (!/^rtmp:\/\/[^\s/]+\/\S*$/i.test(server)) return "The server URL should start with rtmp://";
  if (!s.streamKey.trim()) return "Add your stream key.";
  if (/\s/.test(s.streamKey.trim())) return "The stream key shouldn't contain spaces.";
  return null;
}

/** The single rtmp:// push address Vidu relays to: server URL + "/" + stream key. */
export function goLiveRtmpUrl(s: GoLiveSettings): string {
  return `${s.server.trim().replace(/\/+$/, "")}/${s.streamKey.trim().replace(/^\/+/, "")}`;
}

export function goLivePlatformLabel(s: GoLiveSettings) {
  return s.platform === "custom" ? "your platform" : GO_LIVE_PLATFORMS[s.platform].label;
}
