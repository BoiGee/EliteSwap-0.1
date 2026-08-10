import { useNavigate } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { Button } from "@/components/ui/button";
import { TopReviews } from "@/components/TopReviews";
import PromoBanner from "@/components/PromoBanner";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import logo from "@/assets/logo.jpg";


export default function Landing() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen flex flex-col relative overflow-hidden">
      <Helmet>
        <title>EliteSwap — Realtime AI Face &amp; Character Swap</title>
        <meta name="description" content="Transform yourself into any character live with EliteSwap — realtime AI face swap for OBS Studio, low-latency and webcam-driven." />
        <link rel="canonical" href="https://eliteswap.online/" />
        <meta property="og:title" content="EliteSwap — Realtime AI Face &amp; Character Swap" />
        <meta property="og:description" content="Realtime AI face and character swap for streamers — OBS Studio compatible." />
        <meta property="og:url" content="https://eliteswap.online/" />
      </Helmet>
      {/* Background effects */}

      <div className="absolute inset-0 scanline pointer-events-none opacity-30" />
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[600px] rounded-full bg-primary/5 blur-[120px]" />

      {/* Promo banner */}
      <div className="relative z-30">
        <PromoBanner variant="hero" />
      </div>

      {/* Header */}
      <header className="relative z-20 flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-3 cursor-pointer" onClick={() => navigate("/")}>
          <img src={logo} alt="Elite Swap" className="w-10 h-10 rounded-lg" />
          <span className="text-xl font-heading font-bold gradient-text">Elite Swap</span>
        </div>
        <div className="flex items-center gap-3">
          <LanguageSwitcher />
          <Button variant="ghost" onClick={() => navigate("/forum")} className="font-heading text-sm">Forum</Button>
          <Button variant="ghost" onClick={() => navigate("/pricing")} className="font-heading text-sm">Pricing</Button>
          <Button onClick={() => navigate("/auth")} className="font-heading text-sm neon-glow">Get Started</Button>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-lg space-y-10 text-center relative z-10">
          <div className="space-y-4">
            <h1 className="text-6xl md:text-7xl font-heading font-bold gradient-text">Elite Swap — Realtime AI Character Transformation</h1>

            <p className="text-lg text-muted-foreground font-body max-w-md mx-auto">
              Realtime AI character swap & character transformation - compatible with OBS Studio.
            </p>
          </div>

          <div className="glass neon-border rounded-2xl p-8 space-y-4">
            <h2 className="text-xl font-heading font-semibold text-foreground">Get Started</h2>
            <p className="text-sm text-muted-foreground">
              Create an account, make a payment, and receive your API key instantly.
            </p>
            <div className="flex flex-col gap-3">
              <Button
                onClick={() => navigate("/auth?redirect=trial")}
                className="w-full bg-gradient-to-r from-primary to-primary/70 text-primary-foreground hover:opacity-90 font-heading font-semibold text-base py-6 neon-glow"
              >
                Start $10 Trial — 4 min 💳
              </Button>
              <Button
                onClick={() => navigate("/auth")}
                variant="outline"
                className="w-full font-heading font-semibold text-base py-6"
              >
                Sign Up / Log In 🚀
              </Button>
              <Button
                variant="ghost"
                onClick={() => navigate("/pricing")}
                className="w-full font-heading font-semibold text-sm"
              >
                View Pricing 💎
              </Button>
            </div>
          </div>

          {/* Top reviews (above demo video) */}
          <TopReviews />

          {/* Demo video */}
          <div className="space-y-3">
            <div className="flex items-center justify-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse-neon" />
              <span className="text-xs font-heading font-semibold tracking-[0.2em] uppercase text-muted-foreground">
                Watch the demo
              </span>
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse-neon" />
            </div>
            <div className="glass neon-border rounded-2xl p-2 overflow-hidden">
              <div className="aspect-video w-full rounded-xl overflow-hidden bg-background/50">
                <iframe
                  src="https://www.youtube.com/embed/6-4vyVxh7Oo?rel=0&modestbranding=1"
                  title="Elite Swap demo"
                  loading="lazy"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  allowFullScreen
                  className="w-full h-full"
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4 text-center">
            {[
              { icon: "🎭", label: "Face Swap", desc: "Drive any face with your webcam" },
              { icon: "⚡", label: "Realtime", desc: "Low-latency WebRTC stream" },
              { icon: "🎬", label: "OBS Ready", desc: "Capture output in OBS Studio" },
            ].map((f) => (
              <div key={f.label} className="glass rounded-xl p-4 space-y-2">
                <div className="text-2xl">{f.icon}</div>
                <div className="text-xs font-heading font-semibold text-foreground/80">{f.label}</div>
                <div className="text-xs text-muted-foreground">{f.desc}</div>
              </div>
            ))}
          </div>

        </div>
      </main>


      {/* Footer */}
      <footer className="relative z-20 border-t border-border/30 px-6 py-6">
        <div className="max-w-4xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <img src={logo} alt="Elite Swap" className="w-7 h-7 rounded-md" />
            <span className="text-sm text-muted-foreground font-heading">© {new Date().getFullYear()} Elite Swap</span>
          </div>
          <div className="flex items-center gap-4">
            <a
              href="https://t.me/elite_toolz"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-sm text-muted-foreground hover:text-primary transition-colors font-heading"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
              Telegram
            </a>
            <a
              href="https://www.youtube.com/channel/UCY4HQMaM7Ztl4B-xO95iR2w"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-sm text-muted-foreground hover:text-destructive transition-colors font-heading"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
              YouTube
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
