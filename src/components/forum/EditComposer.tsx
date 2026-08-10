import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

export default function EditComposer({
  initialTitle,
  initialBody,
  onCancel,
  onSave,
  saveLabel = "Save",
}: {
  initialTitle?: string;
  initialBody: string;
  onCancel: () => void;
  onSave: (data: { title?: string; body_md: string }) => Promise<void>;
  saveLabel?: string;
}) {
  const [title, setTitle] = useState(initialTitle ?? "");
  const [body, setBody] = useState(initialBody);
  const [busy, setBusy] = useState(false);

  async function handleSave() {
    if (body.trim().length < 1) {
      toast.error("Content can't be empty");
      return;
    }
    if (initialTitle !== undefined && title.trim().length < 3) {
      toast.error("Title is too short");
      return;
    }
    setBusy(true);
    try {
      await onSave({
        title: initialTitle !== undefined ? title.trim() : undefined,
        body_md: body.trim(),
      });
    } catch (e: any) {
      toast.error(e?.message || "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-border bg-card/50 p-3">
      {initialTitle !== undefined && (
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title"
          maxLength={200}
        />
      )}
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={4}
        maxLength={10000}
      />
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button size="sm" onClick={handleSave} disabled={busy}>{busy ? "Saving…" : saveLabel}</Button>
      </div>
    </div>
  );
}
