import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  GraduationCap,
  KeyRound,
  Copy,
  Rocket,
  ClipboardPaste,
  Camera,
  PartyPopper,
  ArrowLeft,
  ArrowRight,
  type LucideIcon,
} from "lucide-react";

interface Step {
  icon: LucideIcon;
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    icon: GraduationCap,
    title: "Welcome to Elite Swap!",
    body: "This quick guide walks you through everything, step by step: finding your unique key, launching the studio, and starting your first live session.",
  },
  {
    icon: KeyRound,
    title: "Step 1: Find your unique key",
    body: "On this page, open the \"Unique Keys\" tab (step 2 of the Get Started card). Once your trial or plan is active, your key appears there.",
  },
  {
    icon: Copy,
    title: "Step 2: Copy your key",
    body: "Next to your key, hit the \"Copy\" button. You'll paste this into the studio in a moment; keep it handy.",
  },
  {
    icon: Rocket,
    title: "Step 3: Launch the studio",
    body: "Switch to the \"Launch Studio\" tab (step 3) and click \"Launch Elite Swap Studio\". This opens the studio in a new screen.",
  },
  {
    icon: ClipboardPaste,
    title: "Step 4: Paste your key",
    body: "In the studio, paste your key into the \"Studio Access Key\" field and click \"Enter Studio →\".",
  },
  {
    icon: Camera,
    title: "Step 5: Get ready",
    body: "Allow camera and microphone access when your browser asks. Then pick a character preset or upload your own reference photo.",
  },
  {
    icon: PartyPopper,
    title: "Step 6: Start your session",
    body: "Hit connect and you're live! Your timer only counts down while you're connected; disconnect any time and your remaining minutes are still waiting for you.",
  },
];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDisableAutoShow: () => void;
}

export default function TutorialGuideModal({ open, onOpenChange, onDisableAutoShow }: Props) {
  const [step, setStep] = useState(0);
  const [dontShowAgain, setDontShowAgain] = useState(false);

  const isLast = step === STEPS.length - 1;
  const current = STEPS[step];
  const Icon = current.icon;

  const close = () => {
    if (dontShowAgain) onDisableAutoShow();
    onOpenChange(false);
    // Reset for next open so a manual reopen always starts from the top.
    setTimeout(() => setStep(0), 200);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="w-12 h-12 rounded-full bg-primary/15 text-primary flex items-center justify-center mb-1">
            <Icon className="w-6 h-6" strokeWidth={1.75} />
          </div>
          <DialogTitle className="font-heading text-lg">{current.title}</DialogTitle>
          <DialogDescription className="text-sm text-foreground/80 pt-1">{current.body}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-center gap-1.5 py-2">
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-all ${
                i === step ? "w-6 bg-primary" : "w-1.5 bg-muted-foreground/30"
              }`}
            />
          ))}
        </div>

        <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
          <Checkbox checked={dontShowAgain} onCheckedChange={(v) => setDontShowAgain(v === true)} />
          Don't show this automatically again
        </label>

        <DialogFooter className="flex-row items-center justify-between gap-2 sm:justify-between">
          <Button variant="ghost" size="sm" onClick={close} className="font-heading text-xs">
            Skip tutorial
          </Button>
          <div className="flex gap-2">
            {step > 0 && (
              <Button variant="outline" size="sm" onClick={() => setStep((s) => s - 1)} className="font-heading">
                <ArrowLeft className="w-3.5 h-3.5 mr-1" /> Back
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => (isLast ? close() : setStep((s) => s + 1))}
              className="bg-primary text-primary-foreground hover:bg-primary/90 font-heading"
            >
              {isLast ? "Got it!" : "Next"} {!isLast && <ArrowRight className="w-3.5 h-3.5 ml-1" />}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
