import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Info } from "lucide-react";

export const PHOTO_TIPS: string[] = [
  "Use a well-lit, front-facing solo photo.",
  "At least 512×512 pixels — larger is better.",
  "Face clearly visible, not cropped by the edge.",
  "No sunglasses, masks, or heavy occlusions.",
  "Sharp focus — avoid motion blur.",
];

export function PhotoTipsList() {
  return (
    <ul className="list-disc pl-4 space-y-1 text-sm text-muted-foreground">
      {PHOTO_TIPS.map((t) => (
        <li key={t}>{t}</li>
      ))}
    </ul>
  );
}

export function PhotoTipsPopover() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <Info className="w-3 h-3" />
          Photo tips
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72">
        <p className="text-sm font-medium mb-2">Best reference photos</p>
        <PhotoTipsList />
      </PopoverContent>
    </Popover>
  );
}
