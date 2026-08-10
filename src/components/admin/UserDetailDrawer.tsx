import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { TERMS_VERSION } from "@/lib/termsContent";

interface Props {
  userId: string | null;
  onClose: () => void;
}

type Bundle = {
  profile: any | null;
  payments: any[];
  plans: Record<string, { name: string; price_usd: number }>;
  apiKeys: any[];
  sessions: any[];
  activity: any[];
  supportConvs: any[];
  review: any | null;
  partner: { code: string; display_name: string | null; source: string; attributed_at: string } | null;
  redemptions: any[];
  freeTrial: any | null;
  termsAcceptances: Array<{ id: string; terms_version: string; source: string; user_agent: string | null; accepted_at: string }>;
};

const fmtUsd = (n: number) => `$${n.toFixed(2)}`;
const fmtDate = (s?: string | null) => (s ? new Date(s).toLocaleString() : "—");
const fmtMs = (ms: number) => {
  if (!ms || ms <= 0) return "0m";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return `${h}h ${m}m`;
};

export default function UserDetailDrawer({ userId, onClose }: Props) {
  const [data, setData] = useState<Bundle | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!userId) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const [
        profileRes, paymentsRes, plansRes, keysRes, sessionsRes,
        activityRes, supportRes, reviewRes, attrRes, redemptionsRes, ftRes, termsRes,
      ] = await Promise.all([
        supabase.from("profiles").select("*").eq("user_id", userId).maybeSingle(),
        supabase.from("payments").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
        supabase.from("pricing_plans").select("id,name,price_usd"),
        supabase.from("api_keys").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
        supabase.from("studio_sessions" as any).select("id,api_key_id,session_id,started_at,ended_at,last_heartbeat_at,duration_ms,end_reason,is_trial,key_label,remaining_ms_at_start,remaining_ms_at_end").eq("user_id", userId).order("started_at", { ascending: false }).limit(200),
        supabase.from("user_activity_logs" as any).select("action,page,created_at,metadata").eq("user_id", userId).order("created_at", { ascending: false }).limit(20),
        supabase.from("support_conversations" as any).select("id,subject,status,priority,created_at,updated_at").eq("user_id", userId).order("updated_at", { ascending: false }),
        supabase.from("reviews").select("rating,remark,created_at,is_approved").eq("user_id", userId).maybeSingle(),
        supabase.from("partner_attributions" as any).select("source,attributed_at,partner_id,partners:partner_id(code,display_name)").eq("user_id", userId).maybeSingle(),
        supabase.from("discount_redemptions" as any).select("discount_amount_usd,redeemed_at,code_id,discount_codes:code_id(code,percent_off)").eq("user_id", userId).order("redeemed_at", { ascending: false }),
        supabase.from("free_trial_assignments" as any).select("created_at,session_number,override_allowed_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("terms_acceptances" as any).select("id,terms_version,source,user_agent,accepted_at").eq("user_id", userId).order("accepted_at", { ascending: false }),
      ]);
      if (cancelled) return;
      const plans: Bundle["plans"] = {};
      (plansRes.data ?? []).forEach((p: any) => { plans[p.id] = { name: p.name, price_usd: Number(p.price_usd) }; });
      const attr: any = attrRes.data;
      const partner = attr && attr.partners
        ? { code: attr.partners.code, display_name: attr.partners.display_name, source: attr.source, attributed_at: attr.attributed_at }
        : null;
      setData({
        profile: profileRes.data,
        payments: paymentsRes.data ?? [],
        plans,
        apiKeys: keysRes.data ?? [],
        sessions: (sessionsRes.data as any[]) ?? [],
        activity: (activityRes.data as any[]) ?? [],
        supportConvs: (supportRes.data as any[]) ?? [],
        review: reviewRes.data,
        partner,
        redemptions: (redemptionsRes.data as any[]) ?? [],
        freeTrial: ftRes.data,
        termsAcceptances: ((termsRes as any).data as any[]) ?? [],
      });
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [userId]);

  const open = !!userId;
  const p = data?.profile;
  const confirmed = data?.payments.filter((x) => x.status === "confirmed") ?? [];
  const lifetime = confirmed.reduce((s, x) => s + Number(x.amount_usd ?? 0), 0);
  const planNames = Array.from(new Set(confirmed.map((x) => x.plan_id ? data?.plans[x.plan_id]?.name : null).filter(Boolean))) as string[];
  const totalStudioMs = (data?.sessions ?? []).reduce((s, x) => s + Number(x.duration_ms ?? 0), 0);

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="font-heading">User Details</SheetTitle>
        </SheetHeader>

        {loading && <div className="py-10 text-center text-muted-foreground animate-pulse">Loading…</div>}
        {!loading && data && (
          <div className="space-y-6 pt-4 text-sm">
            <Section title="Identity">
              <Field label="Display name" value={p?.display_name || "—"} />
              <Field label="Email" value={p?.email || "—"} />
              <Field label="User ID" value={<span className="font-mono text-xs">{userId}</span>} />
              <Field label="Joined" value={fmtDate(p?.created_at)} />
              <Field label="Last seen" value={fmtDate(p?.last_seen_at)} />
              <Field label="Funnel stage" value={String(p?.payment_funnel_stage ?? 0)} />
            </Section>

            <Section title="Payments & lifetime spend">
              <Field label="Lifetime spend" value={<span className="text-primary font-semibold">{fmtUsd(lifetime)}</span>} />
              <Field label="Confirmed payments" value={String(confirmed.length)} />
              <Field label="Total attempts" value={String(data.payments.length)} />
              <Field label="Last paid" value={fmtDate(confirmed[0]?.created_at)} />
              <Field label="Plans purchased" value={planNames.length ? planNames.join(", ") : "—"} />
              <div className="col-span-2 mt-2 space-y-1">
                {data.payments.slice(0, 10).map((pay) => (
                  <div key={pay.id} className="flex items-center justify-between bg-muted/20 rounded px-2 py-1.5 text-xs">
                    <span className="text-muted-foreground">{new Date(pay.created_at).toLocaleDateString()}</span>
                    <span className="font-heading">{pay.currency ?? pay.payment_method}</span>
                    <span>{pay.plan_id ? data.plans[pay.plan_id]?.name ?? "—" : "—"}</span>
                    <span className="font-semibold">{pay.amount_usd ? fmtUsd(Number(pay.amount_usd)) : "—"}</span>
                    <span className={`px-1.5 rounded ${pay.status === "confirmed" ? "bg-primary/20 text-primary" : pay.status === "rejected" ? "bg-destructive/20 text-destructive" : "bg-amber-500/20 text-amber-400"}`}>{pay.status}</span>
                  </div>
                ))}
                {data.payments.length === 0 && <div className="text-xs text-muted-foreground">No payments.</div>}
              </div>
            </Section>

            <Section title="Usage">
              <Field label="Total studio time" value={fmtMs(totalStudioMs)} />
              <Field label="Sessions (last 20)" value={String(data.sessions.length)} />
              <Field label="Last session" value={fmtDate(data.sessions[0]?.started_at)} />
              <Field label="Unique keys" value={`${data.apiKeys.length} (${data.apiKeys.filter((k) => k.is_active).length} active)`} />
              <div className="col-span-2 mt-2 space-y-2">
                {data.apiKeys.slice(0, 10).map((k) => {
                  const keySessions = data.sessions.filter((s: any) => s.api_key_id === k.id);
                  const firstAt = keySessions.length ? keySessions[keySessions.length - 1].started_at : null;
                  const lastAt = keySessions.length ? (keySessions[0].ended_at ?? keySessions[0].last_heartbeat_at ?? keySessions[0].started_at) : null;
                  const expired = k.expires_at && new Date(k.expires_at).getTime() < Date.now();
                  const inUse = !!k.active_session_id;
                  const exhausted = (Number(k.remaining_ms ?? 0) <= 0);
                  let status = "active"; let cls = "bg-primary/20 text-primary";
                  if (inUse) { status = "in use"; cls = "bg-blue-500/20 text-blue-400"; }
                  else if (exhausted) { status = "exhausted"; cls = "bg-destructive/20 text-destructive"; }
                  else if (expired && keySessions.length === 0) { status = "never used (expired)"; cls = "bg-amber-500/20 text-amber-400"; }
                  else if (expired) { status = "expired"; cls = "bg-muted text-muted-foreground"; }
                  else if (!k.is_active) { status = "inactive"; cls = "bg-muted text-muted-foreground"; }
                  return (
                    <details key={k.id} className="bg-muted/20 rounded px-2 py-1.5 text-xs group">
                      <summary className="flex items-center justify-between gap-2 flex-wrap cursor-pointer list-none">
                        <span className="font-heading">{k.label || "Default"}</span>
                        <span className="text-muted-foreground">remaining {fmtMs(Number(k.remaining_ms ?? 0))}</span>
                        <span className="text-muted-foreground">assigned {fmtDate((k as any).assigned_at ?? k.created_at)}</span>
                        <span className="text-muted-foreground">expires {fmtDate(k.expires_at)}</span>
                        <span className={`px-1.5 rounded ${cls}`}>{status}</span>
                        <span className="text-muted-foreground">· {keySessions.length} conn{keySessions.length === 1 ? "" : "s"}</span>
                      </summary>
                      <div className="mt-2 space-y-1 border-t border-border/40 pt-2">
                        {keySessions.length === 0 ? (
                          <div className="text-muted-foreground italic">No studio connections recorded for this key.</div>
                        ) : (
                          <>
                            <div className="text-[10px] text-muted-foreground">First connect: {fmtDate(firstAt)} · Last activity: {fmtDate(lastAt)}</div>
                            {keySessions.slice(0, 20).map((s: any) => (
                              <div key={s.id} className="flex items-center justify-between gap-2 flex-wrap bg-muted/10 rounded px-2 py-1">
                                <span>{fmtDate(s.started_at)}</span>
                                <span className="text-muted-foreground">→ {s.ended_at ? fmtDate(s.ended_at) : <span className="text-blue-400">live</span>}</span>
                                <span className="text-muted-foreground">{fmtMs(Number(s.duration_ms ?? 0))}</span>
                                <span className="text-muted-foreground text-[10px]">{s.end_reason ?? (s.ended_at ? "—" : "active")}</span>
                              </div>
                            ))}
                          </>
                        )}
                      </div>
                    </details>
                  );
                })}
              </div>
            </Section>

            <Section title="Engagement">
              <Field label="Support conversations" value={String(data.supportConvs.length)} />
              <Field label="Last support activity" value={fmtDate(data.supportConvs[0]?.updated_at)} />
              <Field label="Review" value={data.review ? `${"★".repeat(data.review.rating)} (${data.review.is_approved ? "approved" : "pending"})` : "—"} />
              {data.review?.remark && (
                <div className="col-span-2 italic text-muted-foreground bg-muted/20 rounded px-2 py-1.5 text-xs">"{data.review.remark}"</div>
              )}
              <div className="col-span-2 mt-2 space-y-1">
                <div className="text-xs font-heading text-muted-foreground uppercase tracking-wider">Recent activity</div>
                {data.activity.slice(0, 10).map((a, i) => (
                  <div key={i} className="flex items-center justify-between bg-muted/10 rounded px-2 py-1 text-xs">
                    <span className="font-heading">{a.action}</span>
                    <span className="text-muted-foreground">{a.page ?? "—"}</span>
                    <span className="text-muted-foreground">{new Date(a.created_at).toLocaleString()}</span>
                  </div>
                ))}
                {data.activity.length === 0 && <div className="text-xs text-muted-foreground">No activity.</div>}
              </div>
            </Section>

            <Section title="Attribution & referrals">
              <Field label="Referring partner" value={data.partner ? `${data.partner.code}${data.partner.display_name ? ` — ${data.partner.display_name}` : ""}` : "—"} />
              <Field label="Source" value={data.partner?.source ?? "—"} />
              <Field label="Attributed at" value={fmtDate(data.partner?.attributed_at)} />
              <Field label="Free trial used" value={data.freeTrial ? `Yes (session #${data.freeTrial.session_number}, ${fmtDate(data.freeTrial.created_at)})` : "No"} />
              <div className="col-span-2 mt-2 space-y-1">
                <div className="text-xs font-heading text-muted-foreground uppercase tracking-wider">Discount redemptions</div>
                {data.redemptions.map((r, i) => (
                  <div key={i} className="flex items-center justify-between bg-muted/20 rounded px-2 py-1.5 text-xs">
                    <span className="font-heading">{r.discount_codes?.code ?? "—"}</span>
                    <span>{r.discount_codes?.percent_off ? `${r.discount_codes.percent_off}% off` : ""}</span>
                    <span className="text-primary">-{fmtUsd(Number(r.discount_amount_usd))}</span>
                    <span className="text-muted-foreground">{fmtDate(r.redeemed_at)}</span>
                  </div>
                ))}
                {data.redemptions.length === 0 && <div className="text-xs text-muted-foreground">No discount codes used.</div>}
              </div>
            </Section>

            <Section title="Terms & policies">
              <Field
                label="Current status"
                value={
                  p?.terms_accepted_at && p?.terms_version === TERMS_VERSION
                    ? <span className="text-emerald-400">✓ Accepted current version</span>
                    : p?.terms_accepted_at
                      ? <span className="text-amber-400">⚠ Accepted older version</span>
                      : <span className="text-amber-400">⚠ Never accepted</span>
                }
              />
              <Field label="Version on file" value={p?.terms_version ?? "—"} />
              <Field label="Latest accepted at" value={fmtDate(p?.terms_accepted_at)} />
              <Field label="Acceptance events" value={String(data.termsAcceptances.length)} />
              <div className="col-span-2 mt-2 space-y-1">
                <div className="text-xs font-heading text-muted-foreground uppercase tracking-wider">History</div>
                {data.termsAcceptances.map((t) => (
                  <div key={t.id} className="flex items-center justify-between gap-2 bg-muted/20 rounded px-2 py-1.5 text-xs">
                    <span className="text-muted-foreground whitespace-nowrap">{new Date(t.accepted_at).toLocaleString()}</span>
                    <span className="font-heading">v{t.terms_version}</span>
                    <span className="px-1.5 rounded bg-primary/15 text-primary">{t.source}</span>
                    <span className="text-muted-foreground truncate flex-1 text-right" title={t.user_agent ?? ""}>{t.user_agent ?? "—"}</span>
                  </div>
                ))}
                {data.termsAcceptances.length === 0 && (
                  <div className="text-xs text-muted-foreground">
                    No recorded acceptances yet{p?.terms_accepted_at ? " (legacy acceptance — only profile timestamp on file)" : ""}.
                  </div>
                )}
              </div>
            </Section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="font-heading font-semibold text-foreground text-sm uppercase tracking-wider">{title}</h3>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">{children}</div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="text-xs">
      <div className="text-muted-foreground font-heading">{label}</div>
      <div className="text-foreground/90 mt-0.5">{value}</div>
    </div>
  );
}
