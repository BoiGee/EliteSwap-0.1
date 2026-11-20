import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { PhoneCall } from "lucide-react";
import { CALL_APPS, CALL_TIPS, callAppsFor, callSteps, type CallApp } from "@/lib/callGuide";

interface Props {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  ios: boolean;
  /** A session is running: the camera-only setting applies from the next Connect. */
  connected: boolean;
}

// Phones: use the swap in WhatsApp, Telegram, Zoom, Meet, Messenger or FaceTime calls by sharing
// the screen while the studio runs full screen. Call mode keeps the studio off the microphone.
export function CallModePanel({ enabled, onChange, ios, connected }: Props) {
  const apps = callAppsFor(ios);
  const [app, setApp] = useState<CallApp>("whatsapp");

  return (
    <div className="glass border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-heading font-semibold text-sm text-foreground/80 uppercase tracking-wider flex items-center gap-1.5">
          <PhoneCall className="w-3.5 h-3.5" /> Use in a video call
        </h2>
        <Switch checked={enabled} onCheckedChange={onChange} aria-label="Use in a video call" />
      </div>
      <p className="text-xs text-muted-foreground">
        Show your swapped face in WhatsApp, Telegram, Zoom and other calls by sharing your screen. Your voice stays in the call.
      </p>

      {enabled && (
        <div className="space-y-3">
          {connected && <p className="text-[11px] text-warning">Disconnect and connect again to switch the studio off your microphone.</p>}
          <div className="flex flex-wrap gap-1">
            {apps.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setApp(id)}
                className={`rounded-full px-2.5 py-1 text-[11px] font-heading transition ${app === id ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
              >
                {CALL_APPS[id].label}
              </button>
            ))}
          </div>
          <ol className="list-decimal pl-4 space-y-1.5 text-xs text-foreground/90">
            {callSteps(app, ios).map((s) => <li key={s}>{s}</li>)}
          </ol>
          <ul className="space-y-1 text-[11px] text-muted-foreground">
            {CALL_TIPS.map((t) => <li key={t}>• {t}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
