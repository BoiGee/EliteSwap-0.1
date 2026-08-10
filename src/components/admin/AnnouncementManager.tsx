import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Info, AlertTriangle, AlertOctagon, Megaphone } from "lucide-react";
import ViewersDialog from "./ViewersDialog";
import { useAdmin } from "@/hooks/useAdmin";

type Severity = "info" | "warning" | "critical";

interface Announcement {
  id: string;
  title: string;
  message: string;
  severity: Severity;
  display_banner: boolean;
  display_modal: boolean;
  cta_label: string | null;
  cta_url: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

const blank = {
  title: "",
  message: "",
  severity: "info" as Severity,
  display_banner: true,
  display_modal: false,
  cta_label: "",
  cta_url: "",
  is_active: false,
};

export default function AnnouncementManager() {
  const { toast } = useToast();
  const { isAdmin } = useAdmin();
  const [rows, setRows] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [form, setForm] = useState({ ...blank });
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const fetchAll = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("system_announcements")
      .select("*")
      .order("updated_at", { ascending: false });
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      setRows((data ?? []) as Announcement[]);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchAll();
  }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({ ...blank });
    setOpen(true);
  };

  const openEdit = (a: Announcement) => {
    setEditing(a);
    setForm({
      title: a.title,
      message: a.message,
      severity: a.severity,
      display_banner: a.display_banner,
      display_modal: a.display_modal,
      cta_label: a.cta_label ?? "",
      cta_url: a.cta_url ?? "",
      is_active: a.is_active,
    });
    setOpen(true);
  };

  const save = async () => {
    if (!form.title.trim() || !form.message.trim()) {
      toast({ title: "Title and message are required", variant: "destructive" });
      return;
    }
    if (!form.display_banner && !form.display_modal) {
      toast({ title: "Pick at least one display (banner or modal)", variant: "destructive" });
      return;
    }
    setSaving(true);
    const args = {
      p_title: form.title.trim(),
      p_message: form.message.trim(),
      p_severity: form.severity,
      p_display_banner: form.display_banner,
      p_display_modal: form.display_modal,
      p_cta_label: form.cta_label.trim() || null,
      p_cta_url: form.cta_url.trim() || null,
      p_is_active: form.is_active,
    };
    const { error } = editing
      ? await supabase.rpc("admin_update_announcement", { p_id: editing.id, ...args })
      : await supabase.rpc("admin_create_announcement", args);
    setSaving(false);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      toast({ title: editing ? "Announcement updated 📢" : "Announcement created 📢" });
      setOpen(false);
      fetchAll();
    }
  };

  const toggleActive = async (a: Announcement) => {
    const { error } = await supabase.rpc("admin_set_announcement_active", {
      p_id: a.id,
      p_is_active: !a.is_active,
    });
    if (error) toast({ title: "Error", description: error.message, variant: "destructive" });
    else fetchAll();
  };

  const remove = async (a: Announcement) => {
    if (!confirm(`Delete "${a.title}"?`)) return;
    const { error } = await supabase.rpc("admin_delete_announcement", { p_id: a.id });
    if (error) toast({ title: "Error", description: error.message, variant: "destructive" });
    else {
      toast({ title: "Deleted 🗑️" });
      fetchAll();
    }
  };

  const SeverityIcon = ({ s }: { s: Severity }) => {
    if (s === "critical") return <AlertOctagon className="h-4 w-4 text-red-400" />;
    if (s === "warning") return <AlertTriangle className="h-4 w-4 text-amber-400" />;
    return <Info className="h-4 w-4 text-sky-400" />;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-heading font-bold text-foreground flex items-center gap-2">
          <Megaphone className="h-6 w-6" /> System Announcements
        </h2>
        {isAdmin && <Button onClick={openCreate} className="font-heading">New announcement</Button>}
      </div>

      <p className="text-sm text-muted-foreground">
        Notify all users of maintenance, upgrades, or other system events. Only one announcement can be active at a time.
      </p>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="glass rounded-xl p-8 text-center text-sm text-muted-foreground">
          No announcements yet. Create your first one to notify users.
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((a) => (
            <div key={a.id} className="glass rounded-xl px-4 py-3 flex items-center gap-3 text-sm">
              <SeverityIcon s={a.severity} />
              <div className="flex-1 min-w-0">
                <div className="font-heading font-semibold text-foreground">{a.title}</div>
                <div className="text-xs text-muted-foreground truncate">{a.message}</div>
                <div className="text-xs text-muted-foreground mt-1 flex gap-3">
                  <span>Severity: {a.severity}</span>
                  <span>{a.display_banner && "Banner"} {a.display_banner && a.display_modal && "·"} {a.display_modal && "Modal"}</span>
                  <span>Updated {new Date(a.updated_at).toLocaleString()}</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {isAdmin && (
                  <div className="flex items-center gap-2">
                    <Label className="text-xs font-heading">Active</Label>
                    <Switch checked={a.is_active} onCheckedChange={() => toggleActive(a)} />
                  </div>
                )}
                <ViewersDialog kind="announcement" targetId={a.id} />
                {isAdmin && <Button size="sm" variant="outline" onClick={() => openEdit(a)} className="font-heading text-xs">Edit</Button>}
                {isAdmin && <Button size="sm" variant="outline" onClick={() => remove(a)} className="border-destructive/30 text-destructive hover:bg-destructive/10 font-heading text-xs">Delete</Button>}
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-heading">{editing ? "Edit announcement" : "New announcement"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="font-heading text-xs">Title</Label>
              <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Scheduled maintenance tonight" />
            </div>
            <div className="space-y-1.5">
              <Label className="font-heading text-xs">Message</Label>
              <Textarea rows={4} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} placeholder="We'll be upgrading the platform from 10pm–11pm UTC." />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="font-heading text-xs">Severity</Label>
                <Select value={form.severity} onValueChange={(v) => setForm({ ...form, severity: v as Severity })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="info">Info (blue)</SelectItem>
                    <SelectItem value="warning">Warning (amber)</SelectItem>
                    <SelectItem value="critical">Critical (red, non-dismissible)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="font-heading text-xs">Active</Label>
                <div className="h-10 flex items-center gap-2">
                  <Switch checked={form.is_active} onCheckedChange={(v) => setForm({ ...form, is_active: v })} />
                  <span className="text-xs text-muted-foreground">{form.is_active ? "Will be shown to users" : "Hidden"}</span>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                <Label className="font-heading text-xs">Top banner</Label>
                <Switch checked={form.display_banner} onCheckedChange={(v) => setForm({ ...form, display_banner: v })} />
              </div>
              <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                <Label className="font-heading text-xs">Dashboard modal</Label>
                <Switch checked={form.display_modal} onCheckedChange={(v) => setForm({ ...form, display_modal: v })} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="font-heading text-xs">CTA label (optional)</Label>
                <Input value={form.cta_label} onChange={(e) => setForm({ ...form, cta_label: e.target.value })} placeholder="Learn more" />
              </div>
              <div className="space-y-1.5">
                <Label className="font-heading text-xs">CTA URL (optional)</Label>
                <Input value={form.cta_url} onChange={(e) => setForm({ ...form, cta_url: e.target.value })} placeholder="https://… or /pricing" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} className="font-heading">Cancel</Button>
            <Button onClick={save} disabled={saving} className="font-heading">{saving ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
