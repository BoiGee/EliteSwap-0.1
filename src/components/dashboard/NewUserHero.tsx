import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Check, Volume2, VolumeX } from "lucide-react";
import { openTrialCheckout } from "@/lib/support";
import SupportChatButtons from "./SupportChatButtons";

interface Props {
  /** Trial price as shown to this visitor, e.g. "$10" or "GH₵150". */
  trialPrice: string;
  onSeePlans: () => void;
}

/**
 * First thing a new account sees (no key, no purchase yet). Most buyers decide within an hour of
 * signing up, so this shows the product working and offers one clear next step: the trial.
 */
export default function NewUserHero({ trialPrice, onSeePlans }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);

  useEffect(() => {
    // Some browsers block autoplay until play() is called explicitly (muted is allowed).
    videoRef.current?.play().catch(() => {});
  }, []);

  const toggleSound = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
    if (!v.muted) { v.currentTime = 0; v.play().catch(() => {}); }
  };

  return (
    <div className="rounded-2xl border border-primary/40 bg-gradient-to-br from-primary/15 via-primary/5 to-transparent p-5 md:p-6">
      <div className="flex flex-col md:flex-row gap-6 items-center">
        <div className="flex-1 space-y-4 order-2 md:order-1">
          <div className="space-y-2">
            <p className="text-xs font-heading uppercase tracking-wider text-primary">Welcome to Elite Swap</p>
            <h2 className="text-2xl md:text-3xl font-heading font-bold text-foreground leading-tight">
              Become any character. <span className="text-primary">Live.</span>
            </h2>
            <p className="text-sm text-muted-foreground">
              Upload one photo and your webcam brings it to life in real time, ready for OBS, TikTok Live, YouTube,
              Twitch or a video call.
            </p>
          </div>
          <ul className="space-y-1.5 text-sm text-foreground/85">
            {[
              "Your face drives the character: every smile, every word",
              "Elite AI Background puts any scene behind you, no green screen",
              "Landscape or portrait, streamed straight into OBS",
            ].map((t) => (
              <li key={t} className="flex gap-2"><Check className="w-4 h-4 text-primary shrink-0 mt-0.5" />{t}</li>
            ))}
          </ul>
          <div className="space-y-2">
            <Button onClick={openTrialCheckout} className="w-full sm:w-auto bg-primary text-primary-foreground hover:bg-primary/90 font-heading font-semibold text-base py-6 px-8">
              Try it live: 4 minutes for {trialPrice}
            </Button>
            <p className="text-xs text-muted-foreground">Pay by Mobile Money or USDT · no subscription · minutes start only when you connect</p>
          </div>
          <div className="flex items-center gap-x-4 gap-y-2 flex-wrap">
            <button type="button" onClick={onSeePlans} className="text-xs text-primary underline underline-offset-2">
              Ready to go all in? See all plans
            </button>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Questions?</span>
              <SupportChatButtons message="Hi Elite Swap, I just signed up and have a question." />
            </div>
          </div>
        </div>

        <div className="relative order-1 md:order-2 w-full max-w-[220px] md:max-w-[240px] shrink-0">
          <video
            ref={videoRef}
            src="/media/eliteswap-demo.mp4"
            poster="/media/eliteswap-demo-poster.jpg"
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            className="w-full aspect-[9/16] rounded-2xl border border-border object-cover shadow-xl bg-black"
          />
          <button
            type="button"
            onClick={toggleSound}
            className="absolute bottom-3 right-3 h-9 w-9 rounded-full bg-black/70 text-white flex items-center justify-center"
            aria-label={muted ? "Turn sound on" : "Mute"}
          >
            {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}
