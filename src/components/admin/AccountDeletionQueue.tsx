import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

interface Row {
  id: string;
  user_id: string;
  email: string | null;
  requested_by: "self" | "admin";
  requested_at: string;
  purge_after: string;
  purged_at: string | null;
  cancelled_at: string | null;
  notes: string | null;
}

export default function AccountDeletionQueue() {
  const { toast } = useToast();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("account_deletion_requests" as any)
      .select("*")
      .order("requested_at", { ascending: false });
    setRows((data as any) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const cancel = async (userId: string) => {
    const { data, error } = await supabase.functions.invoke("cancel-account-deletion", {
      body: { target_user_id: userId },
    });
    if (error || (data as any)?.code) {
      toast({ title: "Error", description: (data as any)?.message ?? error?.message, variant: "destructive" });
    } else {
      toast({ title: "Deletion cancelled ✅" });
      load();
    }
  };

  const purgeNow = async (userId: string) => {
    if (!confirm("Permanently wipe this user RIGHT NOW? This cannot be undone.")) return;
    const { data, error } = await supabase.functions.invoke("purge-deleted-accounts", {
      body: { target_user_id: userId },
    });
    if (error || (data as any)?.code) {
      toast({ title: "Error", description: (data as any)?.message ?? error?.message, variant: "destructive" });
    } else {
      toast({ title: `Purged ${(data as any)?.purged ?? 0} account(s)` });
      load();
    }
  };

  const status = (r: Row) => {
    if (r.purged_at) return { label: "Purged", cls: "bg-muted text-muted-foreground" };
    if (r.cancelled_at) return { label: "Cancelled", cls: "bg-amber-500/20 text-amber-400" };
    if (new Date(r.purge_after).getTime() <= Date.now())
      return { label: "Due for purge", cls: "bg-destructive/20 text-destructive" };
    return { label: "Pending", cls: "bg-primary/20 text-primary" };
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-heading font-bold text-foreground">Account Deletion Queue</h2>
        <Button variant="outline" size="sm" onClick={load} disabled={loading} className="font-heading text-xs">
          Refresh
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Accounts are fully wiped from our servers 7 days after the request. The daily purge runs at 03:00 UTC.
      </p>

      <div className="space-y-2">
        {rows.map((r) => {
          const s = status(r);
          const isActive = !r.purged_at && !r.cancelled_at;
          return (
            <div key={r.id} className="glass rounded-xl px-4 py-3 flex items-center gap-4 text-sm">
              <div className="flex-1 min-w-0">
                <div className="font-heading text-foreground truncate">{r.email ?? r.user_id.slice(0, 8)}</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  Requested {new Date(r.requested_at).toLocaleString()} by <strong>{r.requested_by}</strong>
                </div>
                <div className="text-xs text-muted-foreground">
                  Purge after: <span className="font-mono">{new Date(r.purge_after).toLocaleString()}</span>
                </div>
                {r.notes && <div className="text-xs text-muted-foreground italic mt-1">"{r.notes}"</div>}
              </div>
              <span className={`text-xs font-heading px-2 py-0.5 rounded-full ${s.cls}`}>{s.label}</span>
              {isActive && (
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => cancel(r.user_id)} className="font-heading text-xs">
                    Cancel
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => purgeNow(r.user_id)}
                    className="font-heading text-xs border-destructive/40 text-destructive hover:bg-destructive/10">
                    Purge now
                  </Button>
                </div>
              )}
            </div>
          );
        })}
        {!loading && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">No deletion requests.</p>
        )}
      </div>
    </div>
  );
}
