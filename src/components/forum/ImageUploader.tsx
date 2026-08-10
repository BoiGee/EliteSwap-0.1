import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Image as ImageIcon, X } from "lucide-react";
import { IMAGE_MAX_BYTES, IMAGE_MIMES } from "@/lib/forum";

export interface PreparedImage {
  file: File;
  preview: string;
}

export default function ImageUploader({
  value,
  onChange,
  max = 4,
}: { value: PreparedImage[]; onChange: (next: PreparedImage[]) => void; max?: number }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);

  function add(files: FileList | null) {
    if (!files) return;
    setErr(null);
    const next: PreparedImage[] = [...value];
    for (const f of Array.from(files)) {
      if (next.length >= max) break;
      if (!IMAGE_MIMES.includes(f.type)) { setErr("Only JPG, PNG, or WEBP"); continue; }
      if (f.size > IMAGE_MAX_BYTES) { setErr("Each image must be ≤ 5MB"); continue; }
      next.push({ file: f, preview: URL.createObjectURL(f) });
    }
    onChange(next);
  }

  function remove(idx: number) {
    const item = value[idx];
    if (item) URL.revokeObjectURL(item.preview);
    onChange(value.filter((_, i) => i !== idx));
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {value.map((p, i) => (
          <div key={i} className="relative">
            <img src={p.preview} alt="" className="w-20 h-20 object-cover rounded border border-border" />
            <button
              type="button"
              onClick={() => remove(i)}
              className="absolute -top-2 -right-2 bg-destructive text-destructive-foreground rounded-full p-0.5"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
        {value.length < max && (
          <Button type="button" size="sm" variant="outline" onClick={() => inputRef.current?.click()}>
            <ImageIcon className="w-4 h-4 mr-1" /> Add image
          </Button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        className="hidden"
        onChange={(e) => add(e.target.files)}
      />
      {err && <p className="text-xs text-destructive">{err}</p>}
      <p className="text-xs text-muted-foreground">
        Up to {max} images, 5MB each. Images appear after admin review.
      </p>
    </div>
  );
}
