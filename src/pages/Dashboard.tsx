import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { CryptoPayment } from "@/components/CryptoPayment";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { getSafeErrorMessage } from "@/lib/errors";
import ProfileSection from "@/components/dashboard/ProfileSection";
import PricingSection, { type SelectedPlanInfo } from "@/components/dashboard/PricingSection";
import TutorialSection from "@/components/dashboard/TutorialSection";
import TrialBlockedModal from "@/components/dashboard/TrialBlockedModal";
import PromoBanner from "@/components/PromoBanner";
import { ReviewPromptModal } from "@/components/dashboard/ReviewPromptModal";
import ReferralCodeInput from "@/components/dashboard/ReferralCodeInput";
import { trackFunnel } from "@/lib/paymentFunnel";
import { notifyAdminPaymentEvent } from "@/lib/adminNotify";
import { useCryptoPrices } from "@/hooks/useCryptoPrices";
import { getDeviceFingerprint } from "@/lib/fingerprint";
import { attachPendingPartnerCode } from "@/lib/partnerCode";
import { ApiKeyTimer } from "@/components/dashboard/ApiKeyTimer";
import { usePartner } from "@/hooks/usePartner";
import SystemAnnouncementModal from "@/components/SystemAnnouncementModal";
import DeleteAccountSection from "@/components/account/DeleteAccountSection";
import CommunityTile from "@/components/dashboard/CommunityTile";
import PartnersLoungeTile from "@/components/dashboard/PartnersLoungeTile";

import NotificationBell from "@/components/NotificationBell";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import AdminAnnouncementBanner from "@/components/AdminAnnouncementBanner";
import CommunityFab from "@/components/dashboard/CommunityFab";
import TrialPurchaseCard from "@/components/dashboard/TrialPurchaseCard";

interface ApiKey {
  id: string;
  key: string;
  label: string | null;
  is_active: boolean;
  expires_at: string | null;
  remaining_ms?: number | null;
  active_session_started_at?: string | null;
  created_at: string;
}

interface Payment {
  id: string;
  currency: string;
  amount_usd: number | null;
  tx_hash: string | null;
  status: string;
  created_at: string;
}

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [showPayment, setShowPayment] = useState(false);
  const [selectedPlanForCrypto, setSelectedPlanForCrypto] = useState<SelectedPlanInfo | null>(null);
  const [txHash, setTxHash] = useState("");
  const [txCurrency, setTxCurrency] = useState<"BTC" | "BNB" | "USDT-BEP20" | "USDT-TRC20">("BTC");
  const [submittingPayment, setSubmittingPayment] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [pricingPrefillCode, setPricingPrefillCode] = useState<string | null>(null);
  const cryptoPrices = useCryptoPrices();
  const [hasReview, setHasReview] = useState<boolean>(false);
  const [reviewBannerDismissed, setReviewBannerDismissed] = useState<boolean>(false);
  const [reviewModalOpen, setReviewModalOpen] = useState<boolean>(false);
  const [repurchaseMode, setRepurchaseMode] = useState<boolean>(false);
  const { partner, loading: partnerLoading } = usePartner();
  const [partnerPromoDismissed, setPartnerPromoDismissed] = useState<boolean>(false);
  // Lightweight list of active plans for the inline "Submit Transaction Hash"
  // form. Lets users pick which plan they paid for without first opening the
  // wallet modal (otherwise the submit toasts "Choose a plan first").
  const [inlinePlans, setInlinePlans] = useState<{ id: string; name: string; price_usd: number }[]>([]);
  const [inlinePlanId, setInlinePlanId] = useState<string>("");

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("pricing_plans_public")
        .select("id,name,price_usd,sort_order")
        .gt("price_usd", 0)
        .order("sort_order", { ascending: true });
      if (data) setInlinePlans(data as any);
    })();
  }, []);

  // Keep selectedPlanForCrypto in sync with the inline plan picker so a direct
  // hash submission from the dashboard form can be credited to the right plan.
  useEffect(() => {
    if (!inlinePlanId) return;
    const p = inlinePlans.find((x) => x.id === inlinePlanId);
    if (!p) return;
    setSelectedPlanForCrypto({
      id: p.id,
      name: p.name,
      priceUsd: Number(p.price_usd),
      billingLabel: "monthly",
      discount: null,
    });
  }, [inlinePlanId, inlinePlans]);

  useEffect(() => {
    if (!user) return;
    setPartnerPromoDismissed(!!localStorage.getItem(`partner-promo-dismissed-${user.id}`));
  }, [user]);

  const dismissPartnerPromo = () => {
    if (user) localStorage.setItem(`partner-promo-dismissed-${user.id}`, "1");
    setPartnerPromoDismissed(true);
  };

  const hasConfirmedPayment = payments.some((p) => p.status === "confirmed");
  const usableApiKeys = apiKeys.filter((k) => {
    if (!k.is_active) return false;
    // remaining_ms is the source of truth for paused/idle keys. Only fall back
    // to expires_at when remaining_ms isn't tracked (legacy rows), otherwise a
    // stale expires_at from a prior session would hide a still-valid key.
    if (k.remaining_ms != null) {
      return k.remaining_ms > 0;
    }
    if (k.expires_at && new Date(k.expires_at).getTime() <= nowTick) return false;
    return true;
  });
  const hasActiveFreeTrialKey = apiKeys.some(
    (k) =>
      k.label?.startsWith("Free Trial") &&
      k.is_active &&
      (k.remaining_ms != null
        ? k.remaining_ms > 0
        : !!k.expires_at && new Date(k.expires_at).getTime() > nowTick)
  );
  // Any active key with remaining time also unlocks the studio (covers admin-
  // assigned / partner / comp keys where no payment row exists for this user).
  const canUseStudio = hasConfirmedPayment || hasActiveFreeTrialKey || usableApiKeys.length > 0;

  useEffect(() => {
    // Best-effort: attach any pending referral code now that user is authed.
    if (user) {
      attachPendingPartnerCode("link").then((r) => {
        const res = r.result;
        if (res?.reason === "already_attributed") {
          toast({
            title: "Referral already set",
            description: `Your account is already linked to ${res.existing_code}. Only one referral per account.`,
          });
        } else if (res?.ok) {
          toast({ title: `Referral code applied: ${res.partner_code} 🎉` });
        }
      }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast, user]);

  const [trialBlockedReason, setTrialBlockedReason] = useState<"DEVICE_BLOCKED" | "IP_BLOCKED" | null>(null);
  const [trialsRemaining, setTrialsRemaining] = useState<number | null>(null);

  const fetchTrialsRemaining = async () => {
    if (!user) return;
    const { data } = await supabase.rpc("trial_purchases_remaining" as any, { p_user_id: user.id });
    if (typeof data === "number") setTrialsRemaining(data);
  };
  useEffect(() => { fetchTrialsRemaining(); }, [user?.id]); // eslint-disable-line

  const handleUpgradeFromBlock = () => {
    setTrialBlockedReason(null);
    // Scroll to pricing section
    setTimeout(() => {
      const el = document.getElementById("pricing-section");
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 100);
  };

  const handleContactSupportFromBlock = () => {
    setTrialBlockedReason(null);
    // SupportChat is mounted globally — dispatch a custom event the chat can listen to,
    // fallback: just close the modal so the floating chat button remains visible.
    window.dispatchEvent(new CustomEvent("open-support-chat", {
      detail: { prefill: "Hi — I tried to purchase a $10 trial but it was blocked. Can you help?" },
    }));
  };

  // Re-evaluate gating every second so Step 3 locks instantly when a trial expires
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Proactively flip stale `is_active` rows server-side, then refresh
  useEffect(() => {
    if (!user) return;
    const sweep = async () => {
      try {
        await supabase.rpc("deactivate_expired_api_keys");
      } catch {}
      fetchApiKeys();
    };
    sweep();
    const id = setInterval(sweep, 15000);
    return () => clearInterval(id);
  }, [user]);

  useEffect(() => {
    if (!user) return;
    fetchApiKeys();
    fetchPayments();

    const paymentsChannel = supabase
      .channel(`dashboard-payments-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'payments',
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          fetchPayments();
          if (payload.eventType === 'UPDATE' && (payload.new as Payment).status === 'confirmed') {
            toast({ title: "Payment confirmed! 🎉", description: "You can now generate your API key." });
          } else if (payload.eventType === 'UPDATE' && (payload.new as Payment).status === 'rejected') {
            toast({ title: "Payment rejected ❌", description: "Please contact support or submit a new payment.", variant: "destructive" });
          }
        }
      )
      .subscribe();

    // API-key updates are no longer broadcast via realtime (raw key column
    // must not fan out to client sessions). The 15s sweep above keeps the
    // dashboard in sync with admin edits (assign, activate, label, timer).

    return () => {
      supabase.removeChannel(paymentsChannel);
    };
  }, [user]);


  const fetchApiKeys = async () => {
    const { data } = await supabase.from("api_keys").select("*").order("created_at", { ascending: false });
    if (data) setApiKeys(data);
  };

  const fetchPayments = async () => {
    const { data } = await supabase.from("payments").select("*").order("created_at", { ascending: false });
    if (data) setPayments(data);
  };

  // Check if user has already left a review (for secondary banner)
  useEffect(() => {
    if (!user) return;
    setReviewBannerDismissed(!!localStorage.getItem(`review-banner-dismissed-${user.id}`));
    (async () => {
      const { count } = await supabase
        .from("reviews")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id);
      setHasReview((count ?? 0) > 0);
    })();
  }, [user]);

  // Eligibility for secondary review banner: paid >24h ago, no review, not dismissed
  const oldestConfirmedPayment = payments
    .filter((p) => p.status === "confirmed")
    .reduce<Payment | null>((oldest, p) => {
      if (!oldest) return p;
      return new Date(p.created_at) < new Date(oldest.created_at) ? p : oldest;
    }, null);
  const showReviewBanner =
    hasConfirmedPayment &&
    !hasReview &&
    !reviewBannerDismissed &&
    !!oldestConfirmedPayment &&
    Date.now() - new Date(oldestConfirmedPayment.created_at).getTime() > 24 * 60 * 60 * 1000;

  const dismissReviewBanner = () => {
    if (user) localStorage.setItem(`review-banner-dismissed-${user.id}`, "1");
    setReviewBannerDismissed(true);
  };

  const submitPayment = async (
    hashOverride?: string,
    currencyOverride?: "BTC" | "BNB" | "USDT-BEP20" | "USDT-TRC20",
  ): Promise<boolean> => {
    const effectiveHash = (hashOverride ?? txHash).trim();
    const effectiveCurrency = currencyOverride ?? txCurrency;
    if (!effectiveHash || !user) return false;
    if (!selectedPlanForCrypto) {
      toast({
        title: "Choose a plan first",
        description: "Pick the plan you paid for so your payment can be credited correctly.",
        variant: "destructive",
      });
      document.getElementById("pricing-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return false;
    }
    setSubmittingPayment(true);
    const planForPayment = selectedPlanForCrypto;
    const discountForPayment = planForPayment?.discount ?? null;
    const { data: inserted, error } = await supabase.from("payments").insert({
      user_id: user.id,
      currency: effectiveCurrency,
      tx_hash: effectiveHash,
      status: "pending",
      plan_id: planForPayment?.id ?? null,
      amount_usd: planForPayment?.priceUsd ?? null,
      discount_code: discountForPayment?.code ?? null,
      discount_amount_usd: discountForPayment?.discount_usd ?? null,
    }).select("id").maybeSingle();
    let success = false;
    if (error) {
      console.error('[internal]', error);
      toast({ title: "Error", description: getSafeErrorMessage(error.code), variant: "destructive" });
    } else {
      trackFunnel("funnel_tx_hash_submitted", { currency: effectiveCurrency });
      toast({ title: "Payment submitted! ⏳", description: "We'll verify your transaction and activate your API key." });
      // Fire-and-forget admin alert.
      if (inserted?.id) {
        notifyAdminPaymentEvent({
          paymentId: inserted.id,
          eventType: "pending_review",
          userEmail: user.email ?? null,
          userDisplayName: user.user_metadata?.display_name ?? null,
          currency: effectiveCurrency,
          paymentMethod: "Crypto",
          reference: effectiveHash,
        });
      }
      if (!hashOverride) setTxHash("");
      fetchPayments();
      success = true;
    }
    setSubmittingPayment(false);
    return success;
  };

  const copyKey = (key: string, id: string) => {
    navigator.clipboard.writeText(key);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
    toast({ title: "API key copied! 📋" });
  };

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  return (
    <div className="min-h-screen flex flex-col">
      <SystemAnnouncementModal />
      {showPayment && (
        <CryptoPayment
          onClose={() => setShowPayment(false)}
          selectedPlan={selectedPlanForCrypto}
          onSubmitHash={(hash, currency) => submitPayment(hash, currency)}
        />
      )}

      <TrialBlockedModal
        open={!!trialBlockedReason}
        reason={trialBlockedReason ?? "DEVICE_BLOCKED"}
        onClose={() => setTrialBlockedReason(null)}
        onUpgrade={handleUpgradeFromBlock}
        onContactSupport={handleContactSupportFromBlock}
      />

      <header className="border-b border-border glass px-4 py-3 flex items-center justify-between">
        <h1 className="text-xl font-heading font-bold gradient-text">Elite Swap</h1>
        <div className="flex items-center gap-2 sm:gap-3">
          <span className="hidden sm:inline text-xs text-muted-foreground font-heading">{user?.email}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("/forum")}
            className="font-heading text-xs hidden sm:inline-flex"
          >
            Community
          </Button>
          <LanguageSwitcher compact />
          <NotificationBell />
          
          
          <Button
            variant="outline"
            size="sm"
            onClick={() => setReviewModalOpen(true)}
            className="font-heading text-xs neon-border"
            title={hasReview ? "Update your review" : "Rate & review Elite Swap"}
          >
            {hasReview ? "Update review ⭐" : "Rate & review ⭐"}
          </Button>
          <Button variant="outline" size="sm" onClick={handleSignOut} className="font-heading text-xs">
            Sign Out
          </Button>
        </div>
      </header>
      <AdminAnnouncementBanner />
      <CommunityFab />

      <ReviewPromptModal
        open={reviewModalOpen}
        startWithForm
        title={hasReview ? "Update your review ⭐" : "Leave a quick review ⭐"}
        onClose={() => setReviewModalOpen(false)}
        onDismissForever={() => {
          setHasReview(true);
          if (user) localStorage.setItem(`review-banner-dismissed-${user.id}`, "1");
          setReviewBannerDismissed(true);
        }}
      />

      <div className="flex-1 p-4 md:p-8 max-w-4xl mx-auto w-full space-y-6">
        {/* Profile */}
        <ProfileSection />

        {/* Referral code (only shows if user has none) */}
        <ReferralCodeInput />

        {/* Community */}
        <CommunityTile />
        <PartnersLoungeTile />

        {/* Promo banner — hides automatically once paid */}
        {!hasConfirmedPayment && (
          <PromoBanner
            variant="compact"
            onApplyToPlan={(code) => {
              setPricingPrefillCode(code);
              setTimeout(() => {
                document.getElementById("pricing-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
              }, 50);
            }}
          />
        )}

        {/* Tutorial */}
        <TutorialSection
          isFirstTimer={apiKeys.length === 0 && payments.length === 0}
          trialExhaustedNoPayment={
            apiKeys.filter((k) => k.label?.startsWith("Free Trial")).length >= 2 && !hasConfirmedPayment
          }
        />

        {/* Pricing Plans */}
        {!hasConfirmedPayment && (
          <TrialPurchaseCard
            remaining={trialsRemaining}
            onTrialActivated={() => {
              fetchApiKeys();
              fetchTrialsRemaining();
            }}
          />
        )}

        <div id="pricing-section">
          <PricingSection
            onSelectPlan={(plan) => {
              setSelectedPlanForCrypto(plan);
              setShowPayment(true);
            }}
            hasConfirmedPayment={hasConfirmedPayment}
            prefillCode={pricingPrefillCode}
            onRepurchaseModeChange={setRepurchaseMode}
          />
        </div>

        {/* Step 1: Payment */}
        <div className="glass neon-border rounded-2xl p-6 space-y-4">
          <div className="flex items-center gap-3">
            <span className="w-8 h-8 rounded-full bg-primary/20 text-primary flex items-center justify-center font-heading font-bold text-sm">1</span>
            <h2 className="text-lg font-heading font-semibold text-foreground">Make Payment</h2>
            {hasConfirmedPayment && <span className="text-xs bg-primary/20 text-primary px-2 py-0.5 rounded-full font-heading">✓ Paid</span>}
          </div>

          {(!hasConfirmedPayment || repurchaseMode) && (
            <>
              <p className="text-sm text-muted-foreground">
                Send BTC, BNB, or USDT (BEP-20 / TRC20) to our wallet, then submit your transaction hash below for verification.
              </p>
              <Button
                onClick={() => {
                  if (!selectedPlanForCrypto) {
                    document.getElementById("pricing-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
                    toast({ title: "Select a plan first", description: "Use a plan's Pay with Crypto button before submitting your transaction." });
                    return;
                  }
                  setShowPayment(true);
                }}
                className="bg-primary text-primary-foreground hover:bg-primary/90 font-heading neon-glow"
              >
                💰 View Wallet Addresses
              </Button>

              <div className="border-t border-border pt-4 space-y-3">
                <h3 className="text-sm font-heading font-semibold text-foreground/80">Submit Transaction Hash</h3>
                {/* Live crypto prices */}
                <div className="flex gap-2 text-xs flex-wrap">
                  {cryptoPrices.bitcoin !== null && (
                    <span className="bg-muted/30 rounded-lg px-2 py-1 font-heading">
                      ₿ BTC: <span className="text-foreground font-semibold">${cryptoPrices.bitcoin.toLocaleString()}</span>
                    </span>
                  )}
                  {cryptoPrices.binancecoin !== null && (
                    <span className="bg-muted/30 rounded-lg px-2 py-1 font-heading">
                      ◆ BNB: <span className="text-foreground font-semibold">${cryptoPrices.binancecoin.toLocaleString()}</span>
                    </span>
                  )}
                  <span className="bg-muted/30 rounded-lg px-2 py-1 font-heading">
                    ₮ USDT: <span className="text-foreground font-semibold">$1.00</span>
                  </span>
                </div>
                {/* Plan picker — required so the verifier knows the expected amount.
                    Pre-fills automatically if the user already clicked "Pay with Crypto" on a plan. */}
                <div>
                  <label className="block text-[10px] font-heading uppercase tracking-wider text-muted-foreground mb-1">
                    Plan you paid for
                  </label>
                  <select
                    value={inlinePlanId || selectedPlanForCrypto?.id || ""}
                    onChange={(e) => setInlinePlanId(e.target.value)}
                    className="w-full bg-muted/30 border border-border rounded-lg px-3 py-2 text-sm font-heading text-foreground"
                  >
                    <option value="">— Select the plan you paid for —</option>
                    {inlinePlans.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} — ${Number(p.price_usd).toFixed(0)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex gap-2">
                  <select
                    value={txCurrency}
                    onChange={(e) => setTxCurrency(e.target.value as "BTC" | "BNB" | "USDT-BEP20" | "USDT-TRC20")}
                    className="bg-muted/30 border border-border rounded-lg px-3 py-2 text-sm font-heading text-foreground"
                  >
                    <option value="BTC">BTC</option>
                    <option value="BNB">BNB</option>
                    <option value="USDT-BEP20">USDT (BEP-20)</option>
                    <option value="USDT-TRC20">USDT (TRC20)</option>
                  </select>
                  <Input
                    placeholder="Paste your transaction hash..."
                    value={txHash}
                    onChange={(e) => setTxHash(e.target.value)}
                    className="bg-muted/30 border-border focus:border-primary text-sm flex-1"
                  />
                  <Button onClick={() => submitPayment()} disabled={submittingPayment || !txHash.trim() || (!selectedPlanForCrypto && !inlinePlanId)} size="sm" className="bg-primary text-primary-foreground hover:bg-primary/90 shrink-0">
                    Submit
                  </Button>
                </div>
              </div>
            </>
          )}

          {payments.length > 0 && (
            <div className="space-y-2 pt-2">
              <h3 className="text-xs font-heading text-muted-foreground uppercase tracking-wider">Payment History</h3>
              {payments.map((p) => (
                <div key={p.id} className="flex items-center justify-between bg-muted/20 rounded-lg px-3 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-heading font-semibold">{p.currency}</span>
                    <span className="text-muted-foreground font-mono truncate max-w-[200px]">{p.tx_hash}</span>
                  </div>
                  <span className={`font-heading font-semibold px-2 py-0.5 rounded-full ${
                    p.status === "confirmed" ? "bg-primary/20 text-primary" :
                    p.status === "rejected" ? "bg-destructive/20 text-destructive" :
                    "bg-amber-500/20 text-amber-400"
                  }`}>
                    {p.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Step 2: API Keys */}
        <div className={`glass neon-border rounded-2xl p-6 space-y-4 ${!canUseStudio ? "opacity-50 pointer-events-none" : ""}`}>
          <div className="flex items-center gap-3">
            <span className="w-8 h-8 rounded-full bg-primary/20 text-primary flex items-center justify-center font-heading font-bold text-sm">2</span>
            <h2 className="text-lg font-heading font-semibold text-foreground">Your API Keys</h2>
          </div>

          {!canUseStudio && (
            <p className="text-sm text-muted-foreground">Purchase a $10 trial or a paid plan to unlock your API keys.</p>
          )}

          {canUseStudio && (
            <>
              {apiKeys.length === 0 ? (
                <div className="text-center py-8 space-y-4">
                  <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
                    <span className="text-3xl">⏳</span>
                  </div>
                  <div className="space-y-2">
                    <p className="text-sm font-heading font-semibold text-foreground">Payment confirmed!</p>
                    <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                      Your API key will be sent to <span className="font-semibold text-foreground/80">{user?.email}</span> within <span className="font-semibold text-primary">15 to 60 minutes</span>. Please check your inbox (and spam folder).
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {apiKeys.map((k) => (
                    <div key={k.id} className="flex flex-col sm:flex-row sm:items-center gap-3 bg-muted/20 rounded-lg px-4 py-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="text-xs font-heading text-muted-foreground">{k.label}</span>
                          <ApiKeyTimer
                            remainingMs={k.remaining_ms}
                            activeSessionStartedAt={k.active_session_started_at}
                            expiresAt={k.expires_at}
                            isActive={k.is_active}
                          />
                        </div>
                        <div className="font-mono text-sm text-foreground/80 truncate">{k.key}</div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => copyKey(k.key, k.id)}
                        className="shrink-0 font-heading text-xs self-start sm:self-auto"
                      >
                        {copiedId === k.id ? "Copied!" : "Copy"}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Step 3: Launch Studio */}
        <div className={`glass neon-border rounded-2xl p-6 space-y-4 ${!canUseStudio ? "opacity-50 pointer-events-none" : ""}`}>
          <div className="flex items-center gap-3">
            <span className="w-8 h-8 rounded-full bg-primary/20 text-primary flex items-center justify-center font-heading font-bold text-sm">3</span>
            <h2 className="text-lg font-heading font-semibold text-foreground">Launch Studio</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            {usableApiKeys.length > 0
              ? "Your API key is ready. Launch the realtime face swap studio."
              : hasConfirmedPayment
                ? "Your previous API key has run out of time. Repurchase a plan below to get a fresh key."
                : "Purchase a $10 trial or a paid plan to unlock the studio."}
          </p>
          <Button
            onClick={() => {
              if (usableApiKeys.length > 0) {
                navigate("/studio");
                return;
              }
              if (hasConfirmedPayment) {
                setRepurchaseMode(true);
                toast({
                  title: "Time to top up ⏱️",
                  description: "Pick a plan below to refresh your API key — your account stays the same.",
                });
                setTimeout(() => {
                  document.getElementById("pricing-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
                }, 50);
              }
            }}
            disabled={!canUseStudio}
            className="w-full bg-primary text-primary-foreground hover:bg-primary/90 font-heading font-semibold text-base py-6 neon-glow"
          >
            {usableApiKeys.length > 0 ? "Launch Elite Swap Studio 🚀" : "Repurchase to Launch Studio 🔄"}
          </Button>
        </div>

        {/* Partner program promo for paid non-partners */}
        {hasConfirmedPayment && !partnerLoading && !partner && !partnerPromoDismissed && (
          <div className="glass neon-border rounded-2xl p-6 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-start gap-4 justify-between">
              <div className="space-y-3 flex-1">
                <div className="space-y-1">
                  <p className="text-xs font-heading uppercase tracking-wider text-primary">
                    Partner Program
                  </p>
                  <h2 className="text-lg font-heading font-semibold text-foreground">
                    Earn 20% on every referral — and 5% on theirs 🌳
                  </h2>
                </div>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  <li className="flex items-start gap-2">
                    <span aria-hidden>💸</span>
                    <span>
                      <span className="text-foreground font-medium">20% commission</span> on every
                      purchase your referrals make.
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span aria-hidden>🌳</span>
                    <span>
                      <span className="text-foreground font-medium">5% override</span> when your
                      referrals become partners themselves.
                    </span>
                  </li>
                </ul>
                <p className="text-xs text-muted-foreground">
                  Payouts are reviewed and processed by the team on request from your partner dashboard.
                </p>
              </div>
              <div className="flex sm:flex-col gap-2 shrink-0">
                <Button
                  size="sm"
                  onClick={() => navigate("/partner")}
                  className="font-heading neon-glow"
                >
                  Become a Partner
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={dismissPartnerPromo}
                  className="font-heading"
                >
                  Dismiss
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Secondary review nudge for long-standing paid users */}
        {showReviewBanner && (
          <div className="glass neon-border rounded-2xl p-4 flex flex-col sm:flex-row items-start sm:items-center gap-3 justify-between">
            <div className="space-y-1">
              <p className="text-sm font-heading font-semibold text-foreground">
                Loving Elite Swap? ⭐ Share a quick review
              </p>
              <p className="text-xs text-muted-foreground">
                Your rating goes live on the homepage and helps other creators find us.
              </p>
            </div>
            <div className="flex gap-2 shrink-0">
              <Button
                size="sm"
                onClick={() => navigate("/reviews#leave")}
                className="font-heading neon-glow"
              >
                Leave a review
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={dismissReviewBanner}
                className="font-heading"
              >
                Dismiss
              </Button>
            </div>
          </div>
        )}

        <DeleteAccountSection />
      </div>
    </div>
  );
}
