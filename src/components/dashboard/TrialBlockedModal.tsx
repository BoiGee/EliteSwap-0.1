import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface Props {
  open: boolean;
  onClose: () => void;
  reason: "DEVICE_BLOCKED" | "IP_BLOCKED";
  onUpgrade: () => void;
  onContactSupport: () => void;
}

export default function TrialBlockedModal({ open, onClose, reason, onUpgrade, onContactSupport }: Props) {
  const headline =
    reason === "DEVICE_BLOCKED"
      ? "Looks like a free trial was already used on this device."
      : "Too many free trials from this network.";

  const subline =
    reason === "DEVICE_BLOCKED"
      ? "We allow one free trial per device to keep things fair."
      : "We limit free trials per network to prevent abuse.";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="glass neon-border max-w-md">
        <DialogHeader>
          <div className="text-4xl mb-2">🛡️</div>
          <DialogTitle className="font-heading text-xl text-foreground">{headline}</DialogTitle>
          <DialogDescription className="font-body text-muted-foreground pt-2">
            {subline} Upgrade now to unlock unlimited use — and get <span className="text-primary font-semibold">20% off</span> your first plan.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 pt-2">
          <Button
            onClick={onUpgrade}
            className="w-full bg-primary text-primary-foreground hover:bg-primary/90 font-heading font-semibold neon-glow"
          >
            Upgrade now — 20% off 🎉
          </Button>
          <Button
            onClick={onContactSupport}
            variant="outline"
            className="w-full font-heading"
          >
            Contact support
          </Button>
          <p className="text-xs text-muted-foreground text-center font-body pt-1">
            Shared computer or family member used it? Contact support and we'll sort it out.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
