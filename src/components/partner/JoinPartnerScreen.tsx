import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

interface Props {
  onJoined: () => Promise<void> | void;
}

export default function JoinPartnerScreen({ onJoined }: Props) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [joining, setJoining] = useState(false);

  const handleJoin = async () => {
    setJoining(true);
    const { error } = await supabase.rpc("create_partner_self" as any);
    if (error) {
      const msg = error.message || "Could not join the program";
      const needsPayment = msg.toLowerCase().includes("confirmed purchase");
      toast({
        title: needsPayment ? "Make your first purchase to join" : "Could not join",
        description: needsPayment
          ? "The Partner Program is available after your first confirmed purchase."
          : msg,
        variant: "destructive",
      });
      setJoining(false);
      return;
    }
    toast({ title: "You're in! 🎉", description: "Here's your referral link." });
    await onJoined();
    setJoining(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="glass neon-border rounded-2xl p-6 md:p-8 max-w-lg w-full space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl md:text-3xl font-heading font-bold gradient-text">
            Join the Elite Swap Partner Program
          </h1>
          <p className="text-sm text-muted-foreground font-body">
            Turn your network into recurring income.
          </p>
        </div>

        <div className="space-y-3">
          <div className="flex items-start gap-3 bg-muted/20 rounded-xl p-3">
            <span className="text-2xl">💸</span>
            <div>
              <div className="font-heading font-semibold text-foreground text-sm">
                Earn 20% on every referral
              </div>
              <div className="text-xs text-muted-foreground">
                Paid on every confirmed plan purchase from users who sign up through your link.
              </div>
            </div>
          </div>
          <div className="flex items-start gap-3 bg-muted/20 rounded-xl p-3">
            <span className="text-2xl">🌳</span>
            <div>
              <div className="font-heading font-semibold text-foreground text-sm">
                Earn 5% on your downline
              </div>
              <div className="text-xs text-muted-foreground">
                When your referrals become partners too, you earn an extra 5% override on their sales.
              </div>
            </div>
          </div>
        </div>

        <div className="text-xs text-muted-foreground space-y-1">
          <div className="font-heading font-semibold text-foreground/80">How it works</div>
          <div>1. Join the program</div>
          <div>2. Share your unique referral link</div>
          <div>3. Get paid for every confirmed sale</div>
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          <Button
            onClick={handleJoin}
            disabled={joining}
            className="flex-1 font-heading bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {joining ? "Joining..." : "Become a partner"}
          </Button>
          <Button
            onClick={() => navigate("/dashboard")}
            variant="outline"
            className="font-heading"
            disabled={joining}
          >
            Back to dashboard
          </Button>
        </div>
      </div>
    </div>
  );
}
