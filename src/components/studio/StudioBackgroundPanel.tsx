import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Image as ImageIcon, Trash2, Upload, Sparkles, Palette } from "lucide-react";
import type { BackgroundConfig, BackgroundMode } from "@/hooks/useBackgroundCompositor";

const MAX_FILE_SIZE = 8 * 1024 * 1024;
const BUCKET = "studio-backgrounds";
const SIGN_TTL_SECONDS = 60 * 60 * 6;

interface BackgroundRow {
  id: string;
  storage_path: string;
  file_name: string | null;
  is_active: boolean;
  mode: BackgroundMode;
  chroma_key_color: string | null;
}

interface Props {
  /** Called whenever the active background/mode changes — null when off. */
  onActiveChange: (config: BackgroundConfig | null) => void;
}

export function StudioBackgroundPanel({ onActiveChange }: Props) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [rows, setRows] = useState<BackgroundRow[]>([]);
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("studio_backgrounds" as any)
      .select("id, storage_path, file_name, is_active, mode, chroma_key_color")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    if (!error && data) {
      const list = data as unknown as BackgroundRow[];
      setRows(list);
      const urls: Record<string, string> = {};
      await Promise.all(
        list.map(async (r) => {
          const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(r.storage_path, SIGN_TTL_SECONDS);
          if (signed?.signedUrl) urls[r.id] = signed.signedUrl;
        }),
      );
      setThumbUrls(urls);
      const active = list.find((r) => r.is_active);
      onActiveChange(
        active && urls[active.id]
          ? { imageUrl: urls[active.id], mode: active.mode, chromaKeyColor: active.chroma_key_color ?? undefined }
          : null,
      );
    }
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => { load(); }, [load]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;
    if (file.size > MAX_FILE_SIZE) {
      toast({ title: "Image too large", description: "Max 8MB.", variant: "destructive" });
      return;
    }
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      toast({ title: "Unsupported format", description: "Use JPEG, PNG, or WebP.", variant: "destructive" });
      return;
    }
    setUploading(true);
    const ext = file.name.split(".").pop() || "jpg";
    const path = `${user.id}/${Date.now()}.${ext}`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file);
    if (upErr) {
      toast({ title: "Upload failed", description: upErr.message, variant: "destructive" });
      setUploading(false);
      return;
    }
    const { error: insErr } = await supabase.from("studio_backgrounds" as any).insert({
      user_id: user.id,
      storage_path: path,
      file_name: file.name,
      file_size: file.size,
    } as any);
    setUploading(false);
    if (insErr) {
      toast({ title: "Couldn't save background", description: insErr.message, variant: "destructive" });
      await supabase.storage.from(BUCKET).remove([path]);
      return;
    }
    toast({ title: "Background uploaded" });
    if (fileRef.current) fileRef.current.value = "";
    await load();
  };

  const activate = async (id: string) => {
    const { error } = await supabase.rpc("set_active_studio_background" as any, { p_id: id });
    if (error) { toast({ title: "Couldn't activate", description: error.message, variant: "destructive" }); return; }
    await load();
  };

  const deactivate = async () => {
    const { error } = await supabase.rpc("set_active_studio_background" as any, { p_id: null });
    if (error) { toast({ title: "Couldn't disable", description: error.message, variant: "destructive" }); return; }
    await load();
  };

  const setMode = async (id: string, mode: BackgroundMode, chromaKeyColor?: string) => {
    const { error } = await supabase
      .from("studio_backgrounds" as any)
      .update({ mode, chroma_key_color: chromaKeyColor ?? null } as any)
      .eq("id", id);
    if (error) { toast({ title: "Couldn't update mode", description: error.message, variant: "destructive" }); return; }
    await load();
  };

  const remove = async (row: BackgroundRow) => {
    await supabase.storage.from(BUCKET).remove([row.storage_path]);
    await supabase.from("studio_backgrounds" as any).delete().eq("id", row.id);
    await load();
  };

  const activeRow = rows.find((r) => r.is_active);

  return (
    <div className="glass neon-border rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-heading font-semibold text-sm text-foreground/80 uppercase tracking-wider flex items-center gap-1.5">
          <ImageIcon className="w-3.5 h-3.5" /> Custom Background
        </h2>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/20 text-primary font-heading font-semibold">PRO</span>
      </div>
      <p className="text-xs text-muted-foreground">
        Upload an image to replace what's behind you in the output — AI-segmented, or chroma-key if you have a physical green screen.
      </p>

      <input type="file" ref={fileRef} onChange={handleUpload} accept="image/jpeg,image/png,image/webp" className="hidden" />
      <Button
        size="sm"
        variant="outline"
        className="w-full gap-1.5"
        onClick={() => fileRef.current?.click()}
        disabled={uploading}
      >
        <Upload className="w-3.5 h-3.5" /> {uploading ? "Uploading…" : "Upload background"}
      </Button>

      {loading ? (
        <p className="text-xs text-muted-foreground text-center py-2">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-2">No backgrounds yet.</p>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {rows.map((r) => (
            <button
              key={r.id}
              onClick={() => (r.is_active ? deactivate() : activate(r.id))}
              className={`relative aspect-square rounded-lg overflow-hidden border-2 transition-colors group ${
                r.is_active ? "border-primary" : "border-border hover:border-primary/50"
              }`}
              title={r.is_active ? "Click to disable" : "Click to activate"}
            >
              {thumbUrls[r.id] ? (
                <img src={thumbUrls[r.id]} alt={r.file_name ?? "Background"} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full bg-muted/30" />
              )}
              {r.is_active && (
                <div className="absolute top-1 left-1 bg-primary text-primary-foreground text-[9px] px-1 rounded font-heading font-semibold">
                  ON
                </div>
              )}
              <span
                role="button"
                onClick={(e) => { e.stopPropagation(); remove(r); }}
                className="absolute top-1 right-1 p-1 rounded bg-background/70 opacity-0 group-hover:opacity-100 transition-opacity hover:text-destructive"
              >
                <Trash2 className="w-3 h-3" />
              </span>
            </button>
          ))}
        </div>
      )}

      {activeRow && (
        <div className="pt-2 border-t border-border space-y-2">
          <p className="text-[11px] text-muted-foreground font-heading">Compositing mode</p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={activeRow.mode === "segmentation" ? "default" : "outline"}
              className="flex-1 gap-1.5 text-xs"
              onClick={() => setMode(activeRow.id, "segmentation")}
            >
              <Sparkles className="w-3.5 h-3.5" /> AI Background
            </Button>
            <Button
              size="sm"
              variant={activeRow.mode === "chromakey" ? "default" : "outline"}
              className="flex-1 gap-1.5 text-xs"
              onClick={() => setMode(activeRow.id, "chromakey", activeRow.chroma_key_color ?? "#00b140")}
            >
              <Palette className="w-3.5 h-3.5" /> Green Screen
            </Button>
          </div>
          {activeRow.mode === "chromakey" && (
            <div className="flex items-center gap-2">
              <label className="text-[11px] text-muted-foreground font-heading">Screen color</label>
              <input
                type="color"
                value={activeRow.chroma_key_color ?? "#00b140"}
                onChange={(e) => setMode(activeRow.id, "chromakey", e.target.value)}
                className="h-6 w-10 rounded border border-border bg-transparent cursor-pointer"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
