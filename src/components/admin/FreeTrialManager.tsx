import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";

interface FreeTrialKey {
  id: string;
  api_key: string;
  claimed_by_user_id: string | null;
  claimed_at: string | null;
  created_at: string;
  trial_duration_ms: number | null;
}

interface AbuseAssignment {
  id: string;
  user_id: string;
  device_fingerprint: string | null;
  ip_hash: string | null;
  override_allowed_at: string | null;
  created_at: string;
}

interface AbuseGroup {
  key: string; // fp or ip
  type: "fingerprint" | "ip";
  value: string;
  userIds: string[];
  count: number;
  latest: string;
  hasOverride: boolean;
}

interface Props {
  emailForUser: (userId: string) => string;
}

const formatDuration = (ms: number | null) => {
  if (!ms || ms <= 0) return "Default (2m)";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0) parts.push(`${s}s`);
  return parts.join(" ") || "0s";
};

const PRESETS: { label: string; ms: number }[] = [
  { label: "1 min", ms: 60_000 },
  { label: "2 min", ms: 120_000 },
  { label: "5 min", ms: 300_000 },
  { label: "10 min", ms: 600_000 },
  { label: "30 min", ms: 1_800_000 },
  { label: "1 hour", ms: 3_600_000 },
];

export default function FreeTrialManager({ emailForUser }: Props) {
  const { toast } = useToast();
  const [keys, setKeys] = useState<FreeTrialKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [bulkInput, setBulkInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [filter, setFilter] = useState<"all" | "available" | "claimed">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkHours, setBulkHours] = useState("");
  const [bulkMinutes, setBulkMinutes] = useState("");
  const [bulkSeconds, setBulkSeconds] = useState("");
  const [applying, setApplying] = useState(false);
  const [view, setView] = useState<"keys" | "abuse">("keys");
  const [assignments, setAssignments] = useState<AbuseAssignment[]>([]);
  const [overriding, setOverriding] = useState<string | null>(null);

  const fetchKeys = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("free_trial_keys")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) {
      toast({ title: "Error loading keys", description: error.message, variant: "destructive" });
    } else if (data) {
      setKeys(data as FreeTrialKey[]);
    }
    setLoading(false);
  }, [toast]);

  const fetchAssignments = useCallback(async () => {
    const { data, error } = await supabase
      .from("free_trial_assignments")
      .select("id,user_id,device_fingerprint,ip_hash,override_allowed_at,created_at")
      .order("created_at", { ascending: false });
    if (error) {
      toast({ title: "Error loading assignments", description: error.message, variant: "destructive" });
    } else if (data) {
      setAssignments(data as AbuseAssignment[]);
    }
  }, [toast]);

  useEffect(() => {
    fetchKeys();
    fetchAssignments();
  }, [fetchKeys, fetchAssignments]);

  const handleAdminOverride = async (fingerprint: string) => {
    setOverriding(fingerprint);
    const { data, error } = await supabase.rpc("admin_allow_trial_for_device", { p_fingerprint: fingerprint });
    if (error) {
      toast({ title: "Override failed", description: error.message, variant: "destructive" });
    } else {
      toast({ title: `Override applied to ${data ?? 0} record(s) ✅` });
      fetchAssignments();
    }
    setOverriding(null);
  };

  // Compute collision groups
  const abuseGroups: AbuseGroup[] = (() => {
    const fpMap = new Map<string, AbuseAssignment[]>();
    const ipMap = new Map<string, AbuseAssignment[]>();
    for (const a of assignments) {
      if (a.device_fingerprint) {
        if (!fpMap.has(a.device_fingerprint)) fpMap.set(a.device_fingerprint, []);
        fpMap.get(a.device_fingerprint)!.push(a);
      }
      if (a.ip_hash) {
        if (!ipMap.has(a.ip_hash)) ipMap.set(a.ip_hash, []);
        ipMap.get(a.ip_hash)!.push(a);
      }
    }
    const groups: AbuseGroup[] = [];
    for (const [fp, list] of fpMap) {
      const userIds = Array.from(new Set(list.map((l) => l.user_id)));
      if (userIds.length >= 2) {
        groups.push({
          key: `fp:${fp}`,
          type: "fingerprint",
          value: fp,
          userIds,
          count: list.length,
          latest: list[0].created_at,
          hasOverride: list.some((l) => l.override_allowed_at !== null),
        });
      }
    }
    for (const [ip, list] of ipMap) {
      const userIds = Array.from(new Set(list.map((l) => l.user_id)));
      if (userIds.length >= 3) {
        groups.push({
          key: `ip:${ip}`,
          type: "ip",
          value: ip,
          userIds,
          count: list.length,
          latest: list[0].created_at,
          hasOverride: list.some((l) => l.override_allowed_at !== null),
        });
      }
    }
    return groups.sort((a, b) => (a.latest < b.latest ? 1 : -1));
  })();

  const handleBulkAdd = async () => {
    const lines = bulkInput
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0) {
      toast({ title: "No keys to add", description: "Paste at least one key.", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    const rows = lines.map((api_key) => ({ api_key }));
    const { error, count } = await supabase
      .from("free_trial_keys")
      .insert(rows, { count: "exact" });
    if (error) {
      toast({
        title: "Some keys may have failed",
        description: error.message.includes("unique") ? "One or more keys already exist in the pool." : error.message,
        variant: "destructive",
      });
    } else {
      toast({ title: `Added ${count ?? lines.length} key(s) ✅` });
      setBulkInput("");
    }
    fetchKeys();
    setSubmitting(false);
  };

  const handleDelete = async (id: string) => {
    const { error } = await supabase.from("free_trial_keys").delete().eq("id", id);
    if (error) {
      toast({ title: "Delete failed", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Key deleted 🗑️" });
      fetchKeys();
    }
  };

  const updateKeyDuration = async (ids: string[], ms: number | null) => {
    if (ids.length === 0) return;
    setApplying(true);
    const { error } = await supabase
      .from("free_trial_keys")
      .update({ trial_duration_ms: ms })
      .in("id", ids);
    if (error) {
      toast({ title: "Update failed", description: error.message, variant: "destructive" });
    } else {
      toast({
        title: ms === null
          ? `Reset ${ids.length} key(s) to default ⏱️`
          : `Applied ${formatDuration(ms)} to ${ids.length} key(s) ⏱️`,
      });
      setBulkHours(""); setBulkMinutes(""); setBulkSeconds("");
      setSelected(new Set());
      fetchKeys();
    }
    setApplying(false);
  };

  const total = keys.length;
  const claimed = keys.filter((k) => k.claimed_by_user_id !== null).length;
  const available = total - claimed;

  const filtered = keys.filter((k) => {
    if (filter === "available") return k.claimed_by_user_id === null;
    if (filter === "claimed") return k.claimed_by_user_id !== null;
    return true;
  });

  // Only unclaimed keys are selectable (changing duration on a claimed one has no effect)
  const selectableIds = filtered.filter((k) => !k.claimed_by_user_id).map((k) => k.id);
  const allSelectableSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  const toggleSelect = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  const toggleSelectAll = () => {
    if (allSelectableSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(selectableIds));
    }
  };

  const bulkMs = (parseFloat(bulkHours) || 0) * 3600000
    + (parseFloat(bulkMinutes) || 0) * 60000
    + (parseFloat(bulkSeconds) || 0) * 1000;

  const maskKey = (key: string) => {
    if (key.length <= 12) return key;
    return `${key.slice(0, 6)}…${key.slice(-4)}`;
  };

  const maskHash = (h: string) => (h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-heading font-bold text-foreground">Free Trial Keys</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Pool of pre-generated API keys handed out as free trials. Each user gets 1.
          Default trial duration is 2 minutes — override per-key below.
        </p>
      </div>

      {/* View switcher */}
      <div className="flex items-center gap-2">
        {([
          { id: "keys", label: "🔑 Keys" },
          { id: "abuse", label: `🛡️ Abuse${abuseGroups.length > 0 ? ` (${abuseGroups.length})` : ""}` },
        ] as const).map((v) => (
          <button
            key={v.id}
            onClick={() => setView(v.id)}
            className={`px-3 py-1.5 rounded-lg font-heading text-xs font-semibold transition-all ${
              view === v.id ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>

      {view === "abuse" && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Showing devices/networks where ≥2 users (fingerprint) or ≥3 users (IP) claimed a free trial.
            Click <span className="text-primary font-semibold">Allow next claim</span> to override the block for genuine cases (shared computer, café user).
          </p>
          {abuseGroups.length === 0 && (
            <p className="text-sm text-muted-foreground">No collisions detected. 🎉</p>
          )}
          {abuseGroups.map((g) => (
            <div key={g.key} className="glass rounded-xl px-4 py-3 space-y-2">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-xs font-heading font-semibold px-2 py-0.5 rounded-full ${
                    g.type === "fingerprint" ? "bg-destructive/20 text-destructive" : "bg-amber-500/20 text-amber-400"
                  }`}>
                    {g.type === "fingerprint" ? "DEVICE" : "NETWORK"}
                  </span>
                  <span className="font-mono text-xs text-foreground/70">{maskHash(g.value)}</span>
                  <span className="text-xs text-muted-foreground">· {g.userIds.length} users · {g.count} claims</span>
                  {g.hasOverride && (
                    <span className="text-xs font-heading text-primary">✓ overridden</span>
                  )}
                </div>
                {g.type === "fingerprint" && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={overriding === g.value}
                    onClick={() => handleAdminOverride(g.value)}
                    className="font-heading text-xs"
                  >
                    {overriding === g.value ? "Applying…" : "Allow next claim"}
                  </Button>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                Users: {g.userIds.map((uid) => emailForUser(uid)).join(", ")}
              </div>
              <div className="text-xs text-muted-foreground">
                Latest claim: {new Date(g.latest).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      )}

      {view === "keys" && (
        <>

      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Total", value: total, color: "text-foreground" },
          { label: "Available", value: available, color: "text-primary" },
          { label: "Claimed", value: claimed, color: "text-muted-foreground" },
        ].map((s) => (
          <div key={s.label} className="glass neon-border rounded-xl p-4 text-center">
            <div className={`text-3xl font-heading font-bold ${s.color}`}>{s.value}</div>
            <div className="text-xs text-muted-foreground font-heading mt-1">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="glass neon-border rounded-xl p-4 space-y-3">
        <h3 className="font-heading font-semibold text-foreground text-sm">Add keys to pool</h3>
        <p className="text-xs text-muted-foreground">One API key per line. Duplicates will be rejected.</p>
        <Textarea
          value={bulkInput}
          onChange={(e) => setBulkInput(e.target.value)}
          placeholder="paste-key-1&#10;paste-key-2&#10;paste-key-3"
          rows={6}
          className="font-mono text-xs bg-muted/30"
        />
        <Button
          onClick={handleBulkAdd}
          disabled={submitting || !bulkInput.trim()}
          className="bg-primary text-primary-foreground hover:bg-primary/90 font-heading text-xs"
        >
          {submitting ? "Adding..." : `Add ${bulkInput.split("\n").filter((l) => l.trim()).length} key(s) to pool`}
        </Button>
      </div>

      {/* Bulk timer controls */}
      <div className="glass neon-border rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-heading font-semibold text-foreground text-sm">
            Set trial timer ⏱️
          </h3>
          <span className="text-xs text-muted-foreground font-heading">
            {selected.size} selected
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Applies to selected unclaimed keys. The chosen duration replaces the default 2 minutes when a user claims that key.
        </p>

        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.ms}
              onClick={() => updateKeyDuration([...selected], p.ms)}
              disabled={applying || selected.size === 0}
              className="px-3 py-1.5 rounded-lg bg-muted/30 hover:bg-primary/10 hover:text-primary text-xs font-heading font-semibold transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {p.label}
            </button>
          ))}
          <button
            onClick={() => updateKeyDuration([...selected], null)}
            disabled={applying || selected.size === 0}
            className="px-3 py-1.5 rounded-lg bg-muted/30 hover:bg-destructive/10 hover:text-destructive text-xs font-heading font-semibold transition-all disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Reset to default
          </button>
        </div>

        <div className="flex flex-wrap items-end gap-2 pt-2 border-t border-border/40">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground font-heading">Hours</label>
            <Input
              type="number" min="0" value={bulkHours}
              onChange={(e) => setBulkHours(e.target.value)}
              placeholder="0" className="w-20 h-9 text-xs"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground font-heading">Minutes</label>
            <Input
              type="number" min="0" value={bulkMinutes}
              onChange={(e) => setBulkMinutes(e.target.value)}
              placeholder="0" className="w-20 h-9 text-xs"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground font-heading">Seconds</label>
            <Input
              type="number" min="0" value={bulkSeconds}
              onChange={(e) => setBulkSeconds(e.target.value)}
              placeholder="0" className="w-20 h-9 text-xs"
            />
          </div>
          <Button
            onClick={() => updateKeyDuration([...selected], bulkMs)}
            disabled={applying || selected.size === 0 || bulkMs <= 0}
            className="bg-primary text-primary-foreground hover:bg-primary/90 font-heading text-xs h-9"
          >
            Apply to {selected.size} key(s)
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {(["all", "available", "claimed"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-lg font-heading text-xs font-semibold capitalize transition-all ${
              filter === f ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {f}
          </button>
        ))}
        {selectableIds.length > 0 && (
          <button
            onClick={toggleSelectAll}
            className="ml-auto px-3 py-1.5 rounded-lg font-heading text-xs font-semibold text-primary hover:bg-primary/10 transition-all"
          >
            {allSelectableSelected ? "Deselect all" : `Select all unclaimed (${selectableIds.length})`}
          </button>
        )}
      </div>

      <div className="space-y-2">
        {loading && <p className="text-sm text-muted-foreground">Loading...</p>}
        {!loading && filtered.length === 0 && (
          <p className="text-sm text-muted-foreground">No keys in this view.</p>
        )}
        {filtered.map((k) => {
          const isClaimed = !!k.claimed_by_user_id;
          const isSelected = selected.has(k.id);
          return (
            <div
              key={k.id}
              className={`glass rounded-xl px-4 py-3 flex items-center gap-4 text-sm transition-all ${
                isSelected ? "ring-1 ring-primary/50 bg-primary/5" : ""
              }`}
            >
              <Checkbox
                checked={isSelected}
                disabled={isClaimed}
                onCheckedChange={() => toggleSelect(k.id)}
                aria-label="Select key"
              />
              <div className="flex-1 min-w-0">
                <div className="font-mono text-xs text-foreground/80">{maskKey(k.api_key)}</div>
                <div className="text-xs text-muted-foreground mt-1 flex items-center gap-2 flex-wrap">
                  <span>Added {new Date(k.created_at).toLocaleString()}</span>
                  <span className="text-primary/80">⏱ {formatDuration(k.trial_duration_ms)}</span>
                </div>
              </div>
              {isClaimed ? (
                <div className="text-right">
                  <div className="text-xs font-heading font-semibold text-muted-foreground">
                    {emailForUser(k.claimed_by_user_id!)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {k.claimed_at ? new Date(k.claimed_at).toLocaleString() : ""}
                  </div>
                </div>
              ) : (
                <span className="text-xs font-heading font-semibold px-2 py-0.5 rounded-full bg-primary/20 text-primary">
                  Available
                </span>
              )}
              {!isClaimed && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleDelete(k.id)}
                  className="border-destructive/30 text-destructive hover:bg-destructive/10 font-heading text-xs"
                >
                  Delete
                </Button>
              )}
            </div>
          );
        })}
      </div>
        </>
      )}
    </div>
  );
}
