import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";
import { PhotoTipsList } from "./PhotoTipsPopover";

type Props = {
  open: boolean;
  reason: string;
  onChooseAnother: () => void;
  onCancel: () => void;
};

export function ReferenceBlockedDialog({ open, reason, onChooseAnother, onCancel }: Props) {
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onCancel(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-destructive" />
            Photo can't be used
          </DialogTitle>
          <DialogDescription>{reason}</DialogDescription>
        </DialogHeader>
        <div className="py-2">
          <p className="text-sm font-medium mb-2">Tips for a great reference:</p>
          <PhotoTipsList />
        </div>
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button onClick={onChooseAnother}>Choose another photo</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
