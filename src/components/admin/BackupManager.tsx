import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

interface BackupRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  table_count: number | null;
  total_rows: number | null;
  file_size_bytes: number | null;
  storage_path: string | null;
  download_url: string | null;
  error_message: string | null;
  triggered_by: string;
  storage_file_count: number | null;
  storage_bytes: number | null;
  auth_user_count: number | null;
  schema_ddl_bytes: number | null;
  extras_ok: Record<string, boolean> | null;
}

function formatBytes(b: number | null) {
  if (!b) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

const EXTRAS_LABELS: Record<string, string> = {
  ddl: "Schema",
  auth_identities: "Identities",
  auth_mfa: "MFA",
  auth_sessions: "Sessions",
  cron: "Cron",
  realtime: "Realtime",
  storage_buckets: "Buckets",
  pgmq: "Queues",
};

function ExtrasCell({ extras }: { extras: Record<string, boolean> | null }) {
  if (!extras) return <span className="text-muted-foreground">—</span>;
  const entries = Object.entries(EXTRAS_LABELS);
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([k, label]) => {
        const ok = extras[k];
        return (
          <span
            key={k}
            title={`${label}: ${ok ? "captured" : "missing"}`}
            className={`text-[10px] px-1.5 py-0.5 rounded font-heading ${
              ok
                ? "bg-primary/15 text-primary"
                : "bg-destructive/15 text-destructive/80"
            }`}
          >
            {ok ? "✓" : "×"} {label}
          </span>
        );
      })}
    </div>
  );
}

export default function BackupManager() {
  const { toast } = useToast();
  const [runs, setRuns] = useState<BackupRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [signing, setSigning] = useState<string | null>(null);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    const { data, error } = await supabase
      .from("backup_runs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(60);
    if (error) {
      if (!opts?.silent) toast({ title: "Failed to load backups", description: error.message, variant: "destructive" });
    } else {
      setRuns((data ?? []) as BackupRun[]);
    }
    if (!opts?.silent) setLoading(false);
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  // The backup itself now runs in the background (it can take anywhere from
  // under a minute to several, well past what's safe to hold a button's
  // loading spinner on) — poll while a run is actually in flight so
  // "running" flips to "success"/"failed" without the admin needing to
  // remember to hit Refresh.
  useEffect(() => {
    if (!runs.some((r) => r.status === "running")) return;
    const id = setInterval(() => load({ silent: true }), 10000);
    return () => clearInterval(id);
  }, [runs, load]);

  const runNow = async () => {
    setRunning(true);
    try {
      const { data, error } = await supabase.functions.invoke("daily-db-backup", {
        body: { trigger: "manual" },
      });
      if (error) throw error;
      toast({
        title: (data as any)?.queued ? "Backup started 🚀" : "Backup complete ✅",
        description: (data as any)?.queued
          ? "Running in the background — this list updates automatically when it finishes."
          : `${(data as any)?.table_count ?? 0} tables, ${formatBytes((data as any)?.file_size_bytes ?? 0)}. Email sent.`,
      });
      await load();
    } catch (e: any) {
      toast({
        title: "Backup failed",
        description: e?.message ?? "Unknown error",
        variant: "destructive",
      });
    } finally {
      setRunning(false);
    }
  };

  // Signed URLs expire after 48h (SIGNED_URL_TTL_SECONDS in the backup
  // function — a storage security-policy max), but backups themselves are
  // kept indefinitely. The stored download_url column goes stale long
  // before the file does, so always mint a fresh one on click rather than
  // trusting whatever was signed at creation time.
  const download = async (run: BackupRun) => {
    setSigning(run.id);
    try {
      const { data, error } = await supabase.functions.invoke("daily-db-backup", {
        body: { mode: "resign", run_id: run.id },
      });
      if (error || !(data as any)?.download_url) {
        throw new Error((data as any)?.error ?? error?.message ?? "Could not sign a download link");
      }
      window.open((data as any).download_url as string, "_blank", "noopener,noreferrer");
    } catch (e: any) {
      toast({ title: "Download failed", description: e?.message ?? "Unknown error", variant: "destructive" });
    } finally {
      setSigning(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-heading font-bold text-foreground">Database Backups</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Daily full-coverage backup at 02:00 UTC — schema + data + auth + config + storage — emailed to the first admin and kept permanently in private storage.
          </p>
        </div>
        <Button
          onClick={runNow}
          disabled={running || runs.some((r) => r.status === "running")}
          className="font-heading"
        >
          {running || runs.some((r) => r.status === "running") ? "Backup running…" : "Run backup now"}
        </Button>
      </div>

      <div className="glass rounded-xl p-4 text-xs text-muted-foreground space-y-2">
        <div className="font-heading text-sm text-foreground">What each zip contains</div>
        <ul className="list-disc pl-5 space-y-1">
          <li><span className="text-foreground">schema/ddl.sql</span> — full public schema: tables, indexes, views, enums, functions, triggers, RLS, policies. Makes a full rebuild possible.</li>
          <li><span className="text-foreground">tables/*.csv</span> — every public table (auto-discovered, 2M-row cap per table).</li>
          <li><span className="text-foreground">auth_users.csv</span>, <span className="text-foreground">auth_identities.csv</span>, <span className="text-foreground">auth_mfa_factors.csv</span>, <span className="text-foreground">auth_sessions.csv</span> — auth data (no password hashes, no tokens).</li>
          <li><span className="text-foreground">config/</span> — pg_cron jobs and recent runs, realtime publication membership, storage bucket settings, pgmq queues.</li>
          <li><span className="text-foreground">storage/&lt;bucket&gt;/…</span> — files from every non-backup bucket. Capped at ~500 MB per run.</li>
          <li><span className="text-foreground">MANIFEST.json</span> — machine-readable summary (per-table row counts, truncation flags, coverage map).</li>
          <li><span className="text-foreground">README.txt</span> — coverage notes and limits.</li>
        </ul>
        <div className="pt-2 font-heading text-sm text-foreground">Not included (by design)</div>
        <p>Password hashes, OAuth refresh tokens, project secrets, and edge function source. These live outside the database — secrets are managed in Supabase project settings, and edge function source lives in the GitHub repo.</p>
      </div>

      <div className="glass neon-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/30 text-xs font-heading text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-2">Started</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-left px-3 py-2">Trigger</th>
              <th className="text-right px-3 py-2">Tables</th>
              <th className="text-right px-3 py-2">Rows</th>
              <th className="text-right px-3 py-2">Auth</th>
              <th className="text-right px-3 py-2">Files</th>
              <th className="text-right px-3 py-2">Schema</th>
              <th className="text-left px-3 py-2">Coverage</th>
              <th className="text-right px-3 py-2">Size</th>
              <th className="text-left px-3 py-2">Download</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={11} className="px-3 py-6 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {!loading && runs.length === 0 && (
              <tr><td colSpan={11} className="px-3 py-6 text-center text-muted-foreground">No backups yet. Click "Run backup now" to create the first one.</td></tr>
            )}
            {runs.map((r) => (
              <tr key={r.id} className="border-t border-border/50">
                <td className="px-3 py-2 text-xs">{new Date(r.started_at).toLocaleString()}</td>
                <td className="px-3 py-2">
                  <span className={`text-xs font-heading font-semibold px-2 py-0.5 rounded-full ${
                    r.status === "success" ? "bg-primary/20 text-primary" :
                    r.status === "failed" ? "bg-destructive/20 text-destructive" :
                    "bg-amber-500/20 text-amber-400"
                  }`}>{r.status}</span>
                  {r.error_message && (
                    <div className="text-[10px] text-destructive mt-1 max-w-[260px] truncate" title={r.error_message}>
                      {r.error_message}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{r.triggered_by}</td>
                <td className="px-3 py-2 text-xs text-right">{r.table_count ?? "—"}</td>
                <td className="px-3 py-2 text-xs text-right">{r.total_rows?.toLocaleString() ?? "—"}</td>
                <td className="px-3 py-2 text-xs text-right">{r.auth_user_count?.toLocaleString() ?? "—"}</td>
                <td className="px-3 py-2 text-xs text-right" title={r.storage_bytes ? `${formatBytes(r.storage_bytes)} of media` : undefined}>
                  {r.storage_file_count?.toLocaleString() ?? "—"}
                </td>
                <td className="px-3 py-2 text-xs text-right" title={r.schema_ddl_bytes ? `${formatBytes(r.schema_ddl_bytes)} DDL` : "missing"}>
                  {r.schema_ddl_bytes ? formatBytes(r.schema_ddl_bytes) : <span className="text-destructive">×</span>}
                </td>
                <td className="px-3 py-2"><ExtrasCell extras={r.extras_ok} /></td>
                <td className="px-3 py-2 text-xs text-right">{formatBytes(r.file_size_bytes)}</td>
                <td className="px-3 py-2 text-xs">
                  {r.storage_path ? (
                    <button
                      onClick={() => download(r)}
                      disabled={signing === r.id}
                      className="text-primary hover:underline font-heading disabled:opacity-50 disabled:no-underline"
                    >
                      {signing === r.id ? "Signing…" : "Download"}
                    </button>
                  ) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
