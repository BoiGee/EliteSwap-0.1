import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import ImageUploader, { type PreparedImage } from "./ImageUploader";
import VoiceRecorder, { type RecordedClip } from "./VoiceRecorder";
import { uploadForumMedia } from "@/lib/forum";
import { toast } from "sonner";

export interface ComposerSubmit {
  body_md: string;
  mediaIds: string[];
}

export default function Composer({
  placeholder,
  submitLabel,
  minLength = 1,
  onSubmit,
}: {
  placeholder?: string;
  submitLabel?: string;
  minLength?: number;
  onSubmit: (data: ComposerSubmit) => Promise<void>;
}) {
  const [body, setBody] = useState("");
  const [images, setImages] = useState<PreparedImage[]>([]);
  const [voice, setVoice] = useState<RecordedClip | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit() {
    if (body.trim().length < minLength) {
      toast.error("Please write something first");
      return;
    }
    setBusy(true);
    try {
      const mediaIds: string[] = [];
      for (const img of images) {
        const m = await uploadForumMedia(img.file, "image");
        mediaIds.push(m.id);
      }
      if (voice) {
        const file = new File([voice.blob], `voice-${Date.now()}.webm`, { type: voice.blob.type });
        const m = await uploadForumMedia(file, "audio", { duration_ms: voice.duration_ms });
        mediaIds.push(m.id);
      }
      await onSubmit({ body_md: body.trim(), mediaIds });
      setBody("");
      images.forEach((i) => URL.revokeObjectURL(i.preview));
      setImages([]);
      setVoice(null);
    } catch (e: any) {
      toast.error(e?.message || "Failed to post");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card/50 p-3">
      <Textarea
        placeholder={placeholder ?? "Share what's on your mind…"}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={4}
        maxLength={10000}
      />
      <ImageUploader value={images} onChange={setImages} />
      <VoiceRecorder onChange={setVoice} />
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Images and voice notes go to an admin for quick review before they appear publicly.
        </p>
        <Button onClick={handleSubmit} disabled={busy}>
          {busy ? "Posting…" : submitLabel ?? "Post"}
        </Button>
      </div>
    </div>
  );
}
