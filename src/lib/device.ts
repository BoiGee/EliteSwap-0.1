// Phone detection for the studio's mobile defaults (portrait view, Data saver, camera flip).
// Tablets count as computers: they're usually on Wi-Fi and can run the desktop layout.

type NavigatorLike = { userAgent?: string; userAgentData?: { mobile?: boolean } };

const nav = (): NavigatorLike | null => (typeof navigator === "undefined" ? null : (navigator as NavigatorLike));

export function isPhone(n: NavigatorLike | null = nav()): boolean {
  if (!n) return false;
  if (typeof n.userAgentData?.mobile === "boolean") return n.userAgentData.mobile;
  return /iPhone|iPod|Android.+Mobile|Windows Phone|Mobi/i.test(n.userAgent || "");
}

export type InAppBrowser = "Facebook" | "Instagram" | "TikTok" | "Snapchat" | "Telegram" | "LinkedIn" | "an app";

// Apps that open links in their own built-in browser. Those usually can't run live video
// (camera or WebRTC blocked), so the studio asks the user to reopen it in Chrome or Safari.
export function inAppBrowser(n: NavigatorLike | null = nav()): InAppBrowser | null {
  const ua = n?.userAgent || "";
  if (/FBAN|FBAV|FB_IAB|FBIOS|MessengerForiOS/i.test(ua)) return "Facebook";
  if (/Instagram/i.test(ua)) return "Instagram";
  if (/musical_ly|BytedanceWebview|TikTok|trill_/i.test(ua)) return "TikTok";
  if (/Snapchat/i.test(ua)) return "Snapchat";
  if (/Telegram/i.test(ua)) return "Telegram";
  if (/LinkedInApp/i.test(ua)) return "LinkedIn";
  // Generic Android WebView ("; wv)") — e.g. an app's own browser screen.
  if (/Android.*;\s*wv\)/i.test(ua)) return "an app";
  return null;
}

export function isIOS(n: NavigatorLike | null = nav()): boolean {
  return /iPhone|iPad|iPod/i.test(n?.userAgent || "");
}
