import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { attachPartnerCodeManual } from "@/lib/partnerCode";

export default function ReferralCodeInput() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [hasAttribution, setHasAttribution] = useState<boolean | null>(null);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [partnerCode, setPartnerCode] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!user) return;
      const { data } = await supabase
        .from("partner_attributions" as any)
        .select("partner_id, partners:partners(code)")
        .eq("user_id", user.id)
        .maybeSingle();
      if (cancelled) return;
      if (data) {
        setHasAttribution(true);
        setPartnerCode(((data as any).partners?.code as string) ?? null);
      } else {
        setHasAttribution(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (hasAttribution === null) return null;

  if (hasAttribution) {
    return (
      <div className="glass rounded-xl p-3 flex items-center justify-between gap-2 flex-wrap">
        <div className="text-xs font-heading">
          <span className="text-muted-foreground">Referral attached: </span>
          <span className="text-primary font-semibold">{partnerCode ?? "—"}</span>
        </div>
        <span className="text-[10px] text-muted-foreground font-heading uppercase tracking-wide">
          Locked · one per account
        </span>
      </div>
    );
  }

  const submit = async () => {
    setSubmitting(true);
    const res = await attachPartnerCodeManual(code);
    setSubmitting(false);
    if (res.ok) {
      toast({ title: "Referral code applied! 🎉" });
      setHasAttribution(true);
      setPartnerCode(res.partner_code ?? code.toUpperCase());
      return;
    }
    const msg =
      res.reason === "invalid_code" ? "Invalid or inactive code" :
      res.reason === "already_attributed" ? `Already linked to ${res.existing_code}. Only one referral per account.` :
      res.reason === "self_referral" ? "You can't refer yourself" :
      "Could not apply code";
    toast({ title: "Cannot apply code", description: msg, variant: "destructive" });
    if (res.reason === "already_attributed") {
      setHasAttribution(true);
      setPartnerCode(res.existing_code ?? null);
    }
  };

  return (
    <div className="glass border border-border rounded-xl p-4 space-y-2">
      <div className="text-sm font-heading font-semibold text-foreground">Got a referral code?</div>
      <p className="text-xs text-muted-foreground">
        Enter the code from the person who referred you. You can only set this once — make sure it's correct.
      </p>
      <div className="flex gap-2">
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="e.g. ONION"
          className="bg-muted/30 border-border focus:border-primary uppercase"
          maxLength={32}
        />
        <Button
          onClick={submit}
          disabled={submitting || code.trim().length === 0}
          className="bg-primary text-primary-foreground hover:bg-primary/90 font-heading"
        >
          {submitting ? "..." : "Apply"}
        </Button>
      </div>
    </div>
  );
}
