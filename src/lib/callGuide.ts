// Phones can't present the swap as a camera to WhatsApp/Telegram/Zoom (iOS has no virtual-camera
// API; Android reserves it for system apps). What works is screen sharing inside the call while
// the studio runs full screen with the camera only. These are the per-app steps for that.

export type CallApp = "whatsapp" | "telegram" | "zoom" | "meet" | "messenger" | "facetime";

export const CALL_APPS: Record<CallApp, { label: string; share: string; iosOnly?: boolean }> = {
  whatsapp: { label: "WhatsApp", share: "Tap the Share screen button in the call controls (on some versions it's under ⋯ More)." },
  telegram: { label: "Telegram", share: "Tap the camera button and choose to share your screen instead of the camera." },
  zoom: { label: "Zoom", share: "Tap Share, then Screen." },
  meet: { label: "Google Meet", share: "Tap ⋯ More, then Share screen." },
  messenger: { label: "Messenger", share: "Open the call menu and tap Share screen." },
  facetime: { label: "FaceTime", share: "Tap the SharePlay button, then Share My Screen.", iosOnly: true },
};

export function callAppsFor(ios: boolean): CallApp[] {
  return (Object.keys(CALL_APPS) as CallApp[]).filter((a) => ios || !CALL_APPS[a].iosOnly);
}

/** The steps for one app, in order. Start the call and the sharing first, connect the studio last. */
export function callSteps(app: CallApp, ios: boolean): string[] {
  const { label, share } = CALL_APPS[app];
  return [
    "Here: turn on Use in a video call and upload your face. Don't connect yet.",
    `Open ${label} and start a video call. Turn your camera off in the call and keep your microphone on.`,
    `${share} ${ios ? "Then tap Start Broadcast." : "Then tap Start now. If your phone asks, share the Chrome app or the entire screen."}`,
    "Come back here and tap Connect. When your swapped face appears, tap Full screen.",
    `Talk normally: your voice goes through ${label}. To finish, tap Disconnect here, then stop sharing in ${label}.`,
  ];
}

export const CALL_TIPS = [
  "Stay on this page during the call. If you switch apps, your camera pauses.",
  "Turn on Do Not Disturb first so your notifications aren't shown to the other person.",
  "The other person sees your shared screen, usually full size, instead of the normal camera box.",
];
