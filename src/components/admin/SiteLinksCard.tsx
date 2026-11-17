import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { rpc, rpcErrorMessage } from "@/lib/db";

/** Admin: the WhatsApp community link shown on every dashboard and in the welcome email. */
export default function SiteLinksCard() {
  const { toast } = useToast();
  const [saved, setSaved] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    rpc<{ whatsapp_group_url?: string }>("get_site_links").then(({ data }) => {
      setSaved(data?.whatsapp_group_url ?? "");
      setValue(data?.whatsapp_group_url ?? "");
    });
  }, []);

  const save = async (next: string) => {
    setBusy(true);
    const { error } = await rpc("admin_set_site_link", { p_key: "whatsapp_group_url", p_value: next });
    setBusy(false);
    if (error) { toast({ title: "Not saved", description: rpcErrorMessage(error), variant: "destructive" }); return; }
    setSaved(next);
    setValue(next);
    toast({ title: next ? "WhatsApp community link saved" : "WhatsApp community link removed", description: next ? "It now shows on every dashboard and in welcome emails." : "The invite card is hidden." });
  };

  return (
    <div className="glass border border-border rounded-xl p-4 space-y-2 mb-4">
      <div className="text-sm font-heading font-semibold text-foreground">WhatsApp community link</div>
      <p className="text-xs text-muted-foreground">
        Shown as a "Join the community" card on every user's dashboard (new, old, paid and unpaid) and in the welcome email.
        If WhatsApp resets your invite link, paste the new one here.
      </p>
      <div className="flex flex-col sm:flex-row gap-2">
        <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://chat.whatsapp.com/…" className="h-9 text-sm font-mono" />
        <Button size="sm" disabled={busy || value.trim() === saved} onClick={() => save(value.trim())} className="font-heading">Save</Button>
        {saved && <Button size="sm" variant="outline" disabled={busy} onClick={() => save("")} className="font-heading">Remove</Button>}
      </div>
      {saved && <p className="text-[11px] text-emerald-400">Live: {saved}</p>}
    </div>
  );
}
