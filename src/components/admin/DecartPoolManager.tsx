import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, KeyRound, ShieldAlert } from "lucide-react";

interface PoolRow {
  id: string;
  decart_key: string;
  is_active: boolean;
  note: string | null;
  created_at: string;
  updated_at: string;
}

interface BypassSignal {
  user_id: string;
  user_email: string | null;
  display_name: string | null;
  incident_count: number;
  total_unmonitored_ms: number;
  last_incident_at: string;
  key_labels: string | null;
}

function formatUnmonitored(ms: number) {
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function DecartPoolManager() {
  const { toast } = useToast();
  const [pool, setPool] = useState<PoolRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newNote, setNewNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [revealedKeys, setRevealedKeys] = useState<Record<string, boolean>>({});
  const [confirmRemove, setConfirmRemove] = useState<PoolRow | null>(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState<PoolRow | null>(null);
  const [bypassSignals, setBypassSignals] = useState<BypassSignal[]>([]);
  const [bypassLoading, setBypassLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("decart_shared_pool" as any)
      .select("*")
      .order("created_at", { ascending: false });
    setLoading(false);
    if (error) {
      toast({ title: "Couldn't load Decart pool", description: error.message, variant: "destructive" });
      return;
    }
    setPool((data ?? []) as unknown as PoolRow[]);
  }, [toast]);

  const fetchBypassSignals = useCallback(async () => {
    setBypassLoading(true);
    const { data, error } = await supabase.rpc("admin_list_heartbeat_bypass_signals" as any, { p_days: 7, p_limit: 50 });
    setBypassLoading(false);
    if (!error) setBypassSignals((data ?? []) as unknown as BypassSignal[]);
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);
  useEffect(() => { fetchBypassSignals(); }, [fetchBypassSignals]);

  const activeCount = pool.filter((r) => r.is_active).length;

  const addKey = async () => {
    const key = newKey.trim();
    if (!key) {
      toast({ title: "Paste a Decart API key", variant: "destructive" });
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("decart_shared_pool" as any).insert({
      decart_key: key,
      note: newNote.trim() || null,
    });
    setSaving(false);
    if (error) {
      toast({ title: "Couldn't add key", description: error.message, variant: "destructive" });
      return;
    }
    toast({ title: "Decart key added to the shared pool 🔑" });
    setNewKey(""); setNewNote(""); setShowAdd(false);
    fetchAll();
  };

  const setActive = async (row: PoolRow, is_active: boolean) => {
    if (!is_active && activeCount <= 1 && row.is_active) {
      toast({
        title: "This is the last active key",
        description: "Deactivating it will break studio connections for every user until another key is active.",
        variant: "destructive",
      });
      setConfirmDeactivate(null);
      return;
    }
    // Audit every status change — deactivating immediately affects every
    // paid user's studio connection routing, the same reason revealKey is
    // audited. Logged before the mutation so the attempt is on record even
    // if the update itself then fails.
    const { error: auditErr } = await supabase.rpc("log_decart_shared_pool_status_change" as any, {
      p_pool_id: row.id,
      p_is_active: is_active,
    });
    if (auditErr) {
      toast({ title: "Blocked", description: auditErr.message, variant: "destructive" });
      setConfirmDeactivate(null);
      return;
    }
    const { error } = await supabase.from("decart_shared_pool" as any).update({ is_active, updated_at: new Date().toISOString() }).eq("id", row.id);
    setConfirmDeactivate(null);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      toast({ title: is_active ? "Key activated" : "Key deactivated" });
      fetchAll();
    }
  };

  const removeKey = async (row: PoolRow) => {
    if (row.is_active && activeCount <= 1) {
      toast({
        title: "This is the last active key",
        description: "Add or activate another key before removing this one.",
        variant: "destructive",
      });
      setConfirmRemove(null);
      return;
    }
    const { error } = await supabase.from("decart_shared_pool" as any).delete().eq("id", row.id);
    setConfirmRemove(null);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Key removed from pool" });
      fetchAll();
    }
  };

  const mask = (k: string) => k.length <= 10 ? k : `${k.slice(0, 6)}…${k.slice(-4)}`;

  const revealKey = async (row: PoolRow) => {
    // Audit every reveal so any future key leak has a paper trail.
    const { error: auditErr } = await supabase.rpc("log_decart_shared_pool_reveal" as any, { p_pool_id: row.id });
    if (auditErr) {
      toast({ title: "Reveal blocked", description: auditErr.message, variant: "destructive" });
      return;
    }
    setRevealedKeys((s) => ({ ...s, [row.id]: true }));
    try {
      await navigator.clipboard.writeText(row.decart_key);
      toast({ title: "Key revealed & copied to clipboard", description: "This action was logged in the admin audit trail." });
    } catch {
      toast({ title: "Key revealed", description: "This action was logged in the admin audit trail." });
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-heading font-bold text-foreground flex items-center gap-2">
            <KeyRound className="w-5 h-5 text-primary" /> Decart Pool
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            The real Decart API key(s) backing every user's studio session. Users never see these — each paid user's
            personal access key is checked and billed independently; the actual connection is assigned randomly from
            whichever keys here are active.
          </p>
        </div>
        <Button onClick={() => setShowAdd(true)} className="font-heading text-xs">+ Add key</Button>
      </div>

      {!loading && activeCount === 0 && (
        <div className="glass border border-destructive/50 rounded-xl p-4 flex items-center gap-2 text-destructive font-heading text-sm">
          <AlertTriangle className="w-4 h-4" />
          No active Decart keys — every studio connection attempt will fail right now.
        </div>
      )}

      <div className="glass neon-border rounded-xl p-4 text-center max-w-[180px] space-y-1">
        <div className="text-2xl font-heading font-bold text-foreground">{activeCount}</div>
        <div className="text-xs text-muted-foreground font-heading">Active key{activeCount === 1 ? "" : "s"}</div>
      </div>

      <div className="glass rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="font-heading text-xs">Key</TableHead>
              <TableHead className="font-heading text-xs">Status</TableHead>
              <TableHead className="font-heading text-xs">Note</TableHead>
              <TableHead className="font-heading text-xs">Added</TableHead>
              <TableHead className="font-heading text-xs text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pool.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">
                  {revealedKeys[r.id] ? (
                    <span className="break-all">{r.decart_key}</span>
                  ) : (
                    <button
                      type="button"
                      className="text-left hover:text-primary underline decoration-dotted"
                      onClick={() => revealKey(r)}
                      title="Click to reveal & copy (audited)"
                    >
                      {mask(r.decart_key)}
                    </button>
                  )}
                </TableCell>
                <TableCell>
                  <span className={`text-xs font-heading px-2 py-0.5 rounded-full ${
                    r.is_active ? "bg-primary/20 text-primary" : "bg-destructive/20 text-destructive"
                  }`}>{r.is_active ? "active" : "inactive"}</span>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{r.note || "—"}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{new Date(r.created_at).toLocaleDateString()}</TableCell>
                <TableCell className="text-right">
                  <div className="flex gap-1 justify-end">
                    {r.is_active ? (
                      <Button size="sm" variant="outline" className="font-heading text-xs" onClick={() => setConfirmDeactivate(r)}>Deactivate</Button>
                    ) : (
                      <Button size="sm" variant="outline" className="font-heading text-xs" onClick={() => setActive(r, true)}>Activate</Button>
                    )}
                    <Button size="sm" variant="outline" className="font-heading text-xs border-destructive/30 text-destructive hover:bg-destructive/10" onClick={() => setConfirmRemove(r)}>Remove</Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {!loading && pool.length === 0 && (
              <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground text-sm py-8">No Decart keys in the pool yet.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
        </div>
      </div>

      <div className="glass rounded-xl overflow-hidden">
        <div className="p-4 border-b border-border">
          <h3 className="text-sm font-heading font-semibold text-foreground flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-amber-500" /> Unmonitored session gaps (last 7 days)
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            Sessions that started normally, then went silent long enough that we had to force-close them without a
            heartbeat — the same signature you'd see from someone bypassing our own billing while keeping the raw
            connection alive, since nothing here can actually terminate the Decart side of a live connection.{" "}
            <strong>This is not proof of abuse</strong> — a single occurrence is completely normal (closed laptop,
            dead wifi, crashed tab). Only users with a repeated pattern are listed. Use judgment; rotate the pool key
            above if you confirm deliberate abuse.
          </p>
        </div>
        <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="font-heading text-xs">User</TableHead>
              <TableHead className="font-heading text-xs">Incidents (7d)</TableHead>
              <TableHead className="font-heading text-xs">Unmonitored time</TableHead>
              <TableHead className="font-heading text-xs">Key(s)</TableHead>
              <TableHead className="font-heading text-xs">Last incident</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {bypassSignals.map((s) => (
              <TableRow key={s.user_id}>
                <TableCell className="text-xs">{s.display_name || s.user_email || s.user_id.slice(0, 8)}</TableCell>
                <TableCell className="text-xs">
                  <span className="font-heading font-semibold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-500">
                    {s.incident_count}
                  </span>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{formatUnmonitored(s.total_unmonitored_ms)} (minimum — actual could be more)</TableCell>
                <TableCell className="text-xs text-muted-foreground">{s.key_labels || "—"}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{new Date(s.last_incident_at).toLocaleString()}</TableCell>
              </TableRow>
            ))}
            {!bypassLoading && bypassSignals.length === 0 && (
              <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground text-sm py-8">No repeated unmonitored-gap patterns in the last 7 days.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
        </div>
      </div>

      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-heading">Add a Decart key to the shared pool</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="font-heading text-xs">Decart API key</Label>
              <Input value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="dct_..." className="font-mono text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label className="font-heading text-xs">Note (optional)</Label>
              <Input value={newNote} onChange={(e) => setNewNote(e.target.value)} placeholder="e.g. secondary account, added Aug 2026" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)} className="font-heading text-xs">Cancel</Button>
            <Button onClick={addKey} disabled={saving} className="font-heading text-xs">{saving ? "Adding…" : "Add to pool"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!confirmRemove} onOpenChange={(o) => !o && setConfirmRemove(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-heading">Remove this Decart key?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This permanently deletes the key from the pool. Any session currently using it keeps working until it ends,
            but no new session will ever be assigned it again.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRemove(null)} className="font-heading text-xs">Cancel</Button>
            <Button variant="destructive" onClick={() => confirmRemove && removeKey(confirmRemove)} className="font-heading text-xs">Remove</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!confirmDeactivate} onOpenChange={(o) => !o && setConfirmDeactivate(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-heading">Deactivate this Decart key?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Every paid user's studio session draws its real Decart credential at random from the active pool. Deactivating
            this key stops new sessions from being assigned it immediately — sessions already using it keep working until
            they end. This action is logged in the admin audit trail.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDeactivate(null)} className="font-heading text-xs">Cancel</Button>
            <Button variant="destructive" onClick={() => confirmDeactivate && setActive(confirmDeactivate, false)} className="font-heading text-xs">Deactivate</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
