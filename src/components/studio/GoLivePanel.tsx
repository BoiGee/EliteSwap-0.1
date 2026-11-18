import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Eye, EyeOff, Radio } from "lucide-react";

import { GO_LIVE_PLATFORMS as PLATFORMS, goLiveProblem, goLivePlatformLabel, saveGoLiveSettings, type GoLivePlatform, type GoLiveSettings } from "@/lib/goLive";

// Go live panel. The RTMP address is fixed when the Vidu session is created, so changes apply
// on the next Connect. The stream key never leaves this device except inside that request.

interface Props {
  settings: GoLiveSettings;
  onChange: (s: GoLiveSettings) => void;
  /** Live session state: whether Vidu is relaying this session (null = not connected). */
  relaying: boolean | null;
  /** The Elite AI background is applied in the studio for this session. */
  backgroundOn: boolean;
}

export function GoLivePanel({ settings, onChange, relaying, backgroundOn }: Props) {
  const [showKey, setShowKey] = useState(false);
  const connected = relaying !== null;
  const p = PLATFORMS[settings.platform];
  const problem = settings.enabled ? goLiveProblem(settings) : null;

  useEffect(() => { saveGoLiveSettings(settings); }, [settings]);

  const set = (patch: Partial<GoLiveSettings>) => onChange({ ...settings, ...patch });
  const pickPlatform = (platform: GoLivePlatform) =>
    set({ platform, server: PLATFORMS[platform].server || (settings.platform === platform ? settings.server : "") });

  return (
    <div className="glass border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-heading font-semibold text-sm text-foreground/80 uppercase tracking-wider flex items-center gap-1.5">
          <Radio className="w-3.5 h-3.5" /> Go live
        </h2>
        <div className="flex items-center gap-2">
          {relaying && (
            <span className="flex items-center gap-1 text-[10px] font-heading uppercase tracking-wider text-destructive">
              <span className="w-1.5 h-1.5 rounded-full bg-destructive animate-pulse" /> Live
            </span>
          )}
          <Switch checked={settings.enabled} onCheckedChange={(enabled) => set({ enabled })} aria-label="Stream directly to a platform" />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Stream your swap straight to YouTube, Twitch or TikTok. No OBS needed. Your stream starts when the swap
        starts and stops when you disconnect.
      </p>

      {settings.enabled && (
        <div className="space-y-2.5">
          <div className="grid grid-cols-4 gap-1">
            {(Object.keys(PLATFORMS) as GoLivePlatform[]).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => pickPlatform(id)}
                className={`rounded-md px-1 py-1.5 text-[11px] font-heading transition ${settings.platform === id ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"}`}
              >
                {PLATFORMS[id].label}
              </button>
            ))}
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground" htmlFor="golive-server">Server URL</label>
            <Input
              id="golive-server"
              value={settings.server}
              onChange={(e) => set({ server: e.target.value })}
              placeholder="rtmp://…"
              autoComplete="off"
              spellCheck={false}
              className="bg-muted/30 border-border focus:border-primary text-xs font-mono"
            />
            <p className="text-[10px] text-muted-foreground/80">{p.serverHint}</p>
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground" htmlFor="golive-key">Stream key</label>
            <div className="flex gap-1.5">
              <Input
                id="golive-key"
                type={showKey ? "text" : "password"}
                value={settings.streamKey}
                onChange={(e) => set({ streamKey: e.target.value })}
                placeholder="Paste your stream key"
                autoComplete="off"
                spellCheck={false}
                className="bg-muted/30 border-border focus:border-primary text-xs font-mono"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="shrink-0 rounded-md border border-border px-2 text-muted-foreground hover:text-foreground"
                aria-label={showKey ? "Hide stream key" : "Show stream key"}
              >
                {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground/80">{p.keyHint}. Saved on this device only.</p>
          </div>

          {problem && <p className="text-[11px] text-destructive">{problem}</p>}
          {connected && (
            <p className="text-[11px] text-muted-foreground">
              {relaying
                ? `Streaming to ${goLivePlatformLabel(settings)}. It can take 10–20 seconds to appear there.`
                : "Changes apply the next time you connect."}
            </p>
          )}
          {backgroundOn && (
            <p className="text-[11px] text-muted-foreground">
              Your live stream shows the character swap without the Elite AI background. To stream with the background, use OBS.
            </p>
          )}
          <p className="text-[10px] text-muted-foreground/80 leading-snug">
            Your microphone is included. Facebook and Kick need RTMPS, so use OBS for those. YouTube and TikTok
            require you to label realistic AI-altered video: turn on their "altered or synthetic content" setting for the stream.
          </p>
        </div>
      )}
    </div>
  );
}
