import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";

interface Health {
  counts_24h: Record<string, number>;
  recent_failures: { created_at: string; template_name: string; recipient_email: string; status: string; error_message: string | null }[];
  queue_depths: Record<string, number> | { error: string };
  rate_limited_until: string | null;
  batch_size: number;
  send_delay_ms: number;
}

const fmt = (s?: string | null) => (s ? new Date(s).toLocaleString() : "—");

export default function EmailHealthPanel() {
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc("admin_email_health" as any);
    setLoading(false);
    if (!error && data) setHealth(data as Health);
  }, []);

  useEffect(() => { load(); }, [load]);

  const queueError = health && "error" in (health.queue_depths as any);
  const dlqDepth = health && !queueError
    ? (health.queue_depths as Record<string, number>).auth_emails_dlq + (health.queue_depths as Record<string, number>).transactional_emails_dlq
    : 0;
  const queueDepth = health && !queueError
    ? (health.queue_depths as Record<string, number>).auth_emails + (health.queue_depths as Record<string, number>).transactional_emails
    : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Delivery pipeline status — nothing else in the admin dashboard surfaces this, so check here first if users report missing emails.
        </p>
        <Button variant="outline" size="sm" onClick={load} disabled={loading} className="font-heading text-xs">{loading ? "…" : "Refresh"}</Button>
      </div>

      {health && queueError && (
        <div className="glass border border-destructive/50 rounded-xl p-3 text-xs font-heading text-destructive">
          ⚠️ pgmq unavailable — the email queue infrastructure itself is missing. No emails can send until this is restored.
        </div>
      )}

      {health && !queueError && dlqDepth > 0 && (
        <div className="glass border border-amber-500/50 rounded-xl p-3 text-xs font-heading text-amber-400">
          ⚠️ {dlqDepth} message{dlqDepth === 1 ? "" : "s"} in the dead-letter queue — exhausted retries and need manual attention.
        </div>
      )}

      {health && health.rate_limited_until && new Date(health.rate_limited_until) > new Date() && (
        <div className="glass border border-amber-500/50 rounded-xl p-3 text-xs font-heading text-amber-400">
          ⚠️ Rate-limited by Resend until {fmt(health.rate_limited_until)} — sends are paused until then.
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Sent (24h)", value: health?.counts_24h?.sent ?? 0, icon: "✅" },
          { label: "Failed (24h)", value: health?.counts_24h?.failed ?? 0, icon: "❌" },
          { label: "DLQ'd (24h)", value: health?.counts_24h?.dlq ?? 0, icon: "☠️" },
          { label: "Pending (24h)", value: health?.counts_24h?.pending ?? 0, icon: "⏳" },
        ].map((s) => (
          <div key={s.label} className="glass neon-border rounded-xl p-4 text-center space-y-1">
            <div className="text-xl">{s.icon}</div>
            <div className="text-xl font-heading font-bold text-foreground">{s.value}</div>
            <div className="text-xs text-muted-foreground font-heading">{s.label}</div>
          </div>
        ))}
      </div>

      {health && !queueError && (
        <div className="glass rounded-xl p-4 text-xs text-muted-foreground space-y-1">
          <div className="font-heading text-sm text-foreground mb-1">Queue depth</div>
          <div>Waiting to send: <span className="text-foreground font-heading">{queueDepth}</span></div>
          <div>Dead-letter queue: <span className="text-foreground font-heading">{dlqDepth}</span></div>
        </div>
      )}

      <div className="glass rounded-xl overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-muted/30 text-muted-foreground font-heading">
            <tr>
              <th className="text-left px-3 py-2">When</th>
              <th className="text-left px-3 py-2">Template</th>
              <th className="text-left px-3 py-2">Recipient</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-left px-3 py-2">Error</th>
            </tr>
          </thead>
          <tbody>
            {(health?.recent_failures ?? []).map((f, i) => (
              <tr key={i} className="border-t border-border/40">
                <td className="px-3 py-2 text-muted-foreground">{fmt(f.created_at)}</td>
                <td className="px-3 py-2">{f.template_name}</td>
                <td className="px-3 py-2 truncate max-w-[160px]">{f.recipient_email}</td>
                <td className="px-3 py-2">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-heading ${f.status === "dlq" ? "bg-destructive/15 text-destructive" : "bg-amber-500/15 text-amber-400"}`}>{f.status}</span>
                </td>
                <td className="px-3 py-2 truncate max-w-[300px] text-muted-foreground" title={f.error_message ?? ""}>{f.error_message ?? "—"}</td>
              </tr>
            ))}
            {health && health.recent_failures.length === 0 && (
              <tr><td colSpan={5} className="text-center text-muted-foreground py-6">No failures or DLQ entries. Healthy.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
