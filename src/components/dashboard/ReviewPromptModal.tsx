import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ReviewForm } from "@/components/ReviewForm";

interface ReviewPromptModalProps {
  open: boolean;
  onClose: () => void;
  onDismissForever: () => void;
  /** When true, jump straight to the form (skip the intro screen). */
  startWithForm?: boolean;
  /** Override the title text shown above the form/intro. */
  title?: string;
}

export function ReviewPromptModal({
  open,
  onClose,
  onDismissForever,
  startWithForm = false,
  title,
}: ReviewPromptModalProps) {
  const [showForm, setShowForm] = useState(startWithForm);

  const handleClose = () => {
    setShowForm(startWithForm);
    onClose();
  };

  const showingForm = showForm || startWithForm;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <DialogContent className="glass neon-border max-w-md">
        <DialogHeader>
          <DialogTitle className="font-heading gradient-text">
            {title ?? (showingForm ? "Leave a quick review ⭐" : "Enjoying Elite Swap?")}
          </DialogTitle>
          <DialogDescription>
            {showingForm
              ? "Your review goes live on the homepage."
              : "Drop a quick rating — it goes live on the homepage and helps others discover us."}
          </DialogDescription>
        </DialogHeader>

        {showingForm ? (
          <ReviewForm
            compact
            onSuccess={() => {
              onDismissForever();
              handleClose();
            }}
          />
        ) : (
          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            <Button
              onClick={() => setShowForm(true)}
              className="flex-1 neon-glow font-heading font-semibold"
            >
              Leave a review ⭐
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                onDismissForever();
                handleClose();
              }}
              className="flex-1 font-heading"
            >
              Maybe later
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
