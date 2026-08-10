import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface TutorialSectionProps {
  isFirstTimer: boolean;
  trialExhaustedNoPayment: boolean;
}

export default function TutorialSection({ isFirstTimer, trialExhaustedNoPayment }: TutorialSectionProps) {
  return (
    <div className="glass neon-border rounded-2xl p-2">
      <Accordion type="single" collapsible defaultValue={isFirstTimer || trialExhaustedNoPayment ? "tutorial" : undefined}>
        <AccordionItem value="tutorial" className="border-0">
          <AccordionTrigger className="px-4 py-3 hover:no-underline">
            <div className="flex items-center gap-3">
              <span className="w-8 h-8 rounded-full bg-primary/20 text-primary flex items-center justify-center font-heading font-bold text-sm">?</span>
              <span className="text-lg font-heading font-semibold text-foreground">How it works — Tutorial</span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-4 pb-4">
            <Tabs defaultValue={trialExhaustedNoPayment ? "paid" : "trial"} className="w-full">
              <TabsList className="grid w-full grid-cols-2 bg-muted/30">
                <TabsTrigger value="trial" className="font-heading">💳 $10 Trial</TabsTrigger>
                <TabsTrigger value="paid" className="font-heading">💎 Paid Plan</TabsTrigger>
              </TabsList>

              {/* $10 TRIAL TAB */}
              <TabsContent value="trial" className="space-y-4 pt-4">
                <div className="space-y-3">
                  <h3 className="text-base font-heading font-semibold text-foreground">Try Elite Swap for $10</h3>
                  <ol className="space-y-3 text-sm text-foreground/80">
                    <li className="flex gap-3">
                      <span className="shrink-0 w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center font-heading font-bold text-xs">1</span>
                      <div>
                        <span className="font-semibold text-foreground">Verify your email.</span> Check your inbox for the confirmation link before purchasing.
                      </div>
                    </li>
                    <li className="flex gap-3">
                      <span className="shrink-0 w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center font-heading font-bold text-xs">2</span>
                      <div>
                        <span className="font-semibold text-foreground">Open the $10 Trial card</span> above and pick a payment method:
                        <ul className="mt-1 list-disc pl-5 space-y-1 text-foreground/70">
                          <li><span className="text-foreground/90 font-semibold">USDT</span> (BEP-20 or TRC20) — send to the displayed wallet, then paste the tx hash to auto-verify.</li>
                          <li><span className="text-foreground/90 font-semibold">Card or Mobile Money (Momo)</span> — pay in GHS at the live FX rate; your key is issued automatically once payment confirms.</li>
                        </ul>
                      </div>
                    </li>
                    <li className="flex gap-3">
                      <span className="shrink-0 w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center font-heading font-bold text-xs">3</span>
                      <div>
                        <span className="font-semibold text-foreground">Step 2 unlocks</span> with a fresh trial API key — 4 minutes of studio time.
                      </div>
                    </li>
                    <li className="flex gap-3">
                      <span className="shrink-0 w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center font-heading font-bold text-xs">4</span>
                      <div>
                        <span className="font-semibold text-foreground">Step 3 unlocks</span> — click "Launch Elite Swap Studio 🚀".
                      </div>
                    </li>
                    <li className="flex gap-3">
                      <span className="shrink-0 w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center font-heading font-bold text-xs">5</span>
                      <div>
                        <span className="font-semibold text-foreground">Allow camera + microphone</span> when your browser prompts you, then pick a character preset or upload a reference photo.
                      </div>
                    </li>
                  </ol>
                </div>

                <div className="border-t border-border pt-4 space-y-2">
                  <h4 className="text-sm font-heading font-semibold text-primary">⏸ Your timer pauses on disconnect</h4>
                  <p className="text-sm text-foreground/80">
                    The 4-minute timer only counts down while you're connected. Disconnect, come back later, and the remaining seconds are still yours — until the key is exhausted.
                  </p>
                </div>

                <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 space-y-1">
                  <p className="text-sm font-heading font-semibold text-amber-300">📌 Trial limits</p>
                  <ul className="text-xs text-foreground/80 space-y-1 list-disc pl-5">
                    <li>$10 per trial key — 4 minutes of studio time.</li>
                    <li>Maximum of 2 trial purchases per account, total.</li>
                    <li>When the timer hits 0, the studio stops automatically.</li>
                    <li>Pick a full paid plan to unlock longer sessions.</li>
                  </ul>
                </div>
              </TabsContent>


              {/* PAID TAB */}
              <TabsContent value="paid" className="space-y-4 pt-4">
                <div className="space-y-3">
                  <h3 className="text-base font-heading font-semibold text-foreground">Upgrade and unlock the full studio</h3>
                  <ol className="space-y-3 text-sm text-foreground/80">
                    <li className="flex gap-3">
                      <span className="shrink-0 w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center font-heading font-bold text-xs">1</span>
                      <div>
                        <span className="font-semibold text-foreground">Pick a plan</span> in the Pricing section above.
                      </div>
                    </li>
                    <li className="flex gap-3">
                      <span className="shrink-0 w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center font-heading font-bold text-xs">2</span>
                      <div>
                        <span className="font-semibold text-foreground">Pay with crypto:</span>
                        <ul className="mt-1 list-disc pl-5 space-y-1 text-foreground/70">
                          <li><span className="text-foreground/90 font-semibold">BTC, BNB, or USDT (BEP-20 / TRC20)</span> — send to the displayed wallet, then paste the tx hash in Step 1.</li>
                        </ul>
                      </div>
                    </li>
                    <li className="flex gap-3">
                      <span className="shrink-0 w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center font-heading font-bold text-xs">3</span>
                      <div>
                        <span className="font-semibold text-foreground">Wait for activation:</span>
                        <ul className="mt-1 list-disc pl-5 space-y-1 text-foreground/70">
                          <li>Crypto: 15–60 min admin verification of your tx hash.</li>
                          <li>You'll get a confirmation email when your key is ready.</li>
                        </ul>
                      </div>
                    </li>
                    <li className="flex gap-3">
                      <span className="shrink-0 w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center font-heading font-bold text-xs">4</span>
                      <div>
                        <span className="font-semibold text-foreground">Copy your API key</span> from Step 2 of your dashboard.
                      </div>
                    </li>
                    <li className="flex gap-3">
                      <span className="shrink-0 w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center font-heading font-bold text-xs">5</span>
                      <div>
                        <span className="font-semibold text-foreground">Launch the studio</span> from Step 3. Your timer pauses on every disconnect — full control over how you spend your minutes.
                      </div>
                    </li>
                    <li className="flex gap-3">
                      <span className="shrink-0 w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center font-heading font-bold text-xs">6</span>
                      <div>
                        <span className="font-semibold text-foreground">Optional — Stream to OBS, Zoom, or Meet</span> using the <code className="text-xs bg-muted/40 px-1 rounded">/obs-output</code> URL with your API key as a virtual camera source.
                      </div>
                    </li>
                  </ol>
                </div>

                <div className="bg-primary/10 border border-primary/30 rounded-lg p-3 space-y-1">
                  <p className="text-sm font-heading font-semibold text-primary">🔒 Your minutes are safe</p>
                  <p className="text-xs text-foreground/80">
                    The session-aware timer means you can disconnect, close the tab, return hours or days later — your remaining balance picks up exactly where you left off.
                  </p>
                </div>
              </TabsContent>
            </Tabs>

            {/* WHY UPGRADE PANEL */}
            {trialExhaustedNoPayment && (
              <div className="mt-6 border-t border-border pt-6">
                <div className="bg-gradient-to-br from-primary/15 via-primary/5 to-transparent border border-primary/30 rounded-xl p-5 space-y-4">
                  <div className="space-y-1">
                    <h3 className="text-lg font-heading font-bold gradient-text">Your trial sessions are used up — here's what you unlock by upgrading</h3>
                    <p className="text-sm text-muted-foreground">No pressure, but here's what paid users get that trial users don't.</p>
                  </div>

                  <ul className="space-y-2.5 text-sm text-foreground/90">
                    <li className="flex gap-2">
                      <span>⏱</span>
                      <span><span className="font-semibold text-foreground">Longer uninterrupted sessions</span> — no 2 or 5-minute cutoffs. Stream, call, or meet for as long as your plan allows.</span>
                    </li>
                    <li className="flex gap-2">
                      <span>⏸</span>
                      <span><span className="font-semibold text-foreground">Pause anytime</span> — your time only counts while connected.</span>
                    </li>
                    <li className="flex gap-2">
                      <span>🎭</span>
                      <span><span className="font-semibold text-foreground">Unlimited character swaps</span> per session.</span>
                    </li>
                    <li className="flex gap-2">
                      <span>📺</span>
                      <span><span className="font-semibold text-foreground">OBS streaming</span> for live broadcasts, Zoom, and Meet.</span>
                    </li>
                    <li className="flex gap-2">
                      <span>🖼</span>
                      <span><span className="font-semibold text-foreground">Custom reference images</span> — be anyone.</span>
                    </li>
                    <li className="flex gap-2">
                      <span>💸</span>
                      <span><span className="font-semibold text-foreground">Pay with crypto</span> — BTC, BNB, or USDT (BEP-20 / TRC20) sent to the displayed wallet.</span>
                    </li>
                    <li className="flex gap-2">
                      <span>📧</span>
                      <span><span className="font-semibold text-foreground">Priority email support</span>.</span>
                    </li>
                    <li className="flex gap-2">
                      <span>🔒</span>
                      <span><span className="font-semibold text-foreground">Session-aware timer</span> — disconnect, return hours later, your remaining time is still there.</span>
                    </li>
                  </ul>

                  <p className="text-xs text-muted-foreground italic">Pick a plan above to keep going. ☝️</p>
                </div>
              </div>
            )}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
