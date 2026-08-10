import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import RecipientPreviewDialog, { RecipientPreviewRow } from "./RecipientPreviewDialog";
import BroadcastHistory from "./BroadcastHistory";
import { Calendar as CalendarIcon, Send, Clock } from "lucide-react";

interface Profile {
  user_id: string;
  email: string | null;
  display_name: string | null;
  created_at: string;
}

type Mode = "single" | "multiple" | "filter" | "all";
type FilterPreset = "paid" | "unpaid" | "new_7d" | "free_trial_used";

const SUBJECT_MAX = 120;
const BODY_MAX = 10000;
const ALL_USERS_CONFIRM_THRESHOLD = 500;

function parseLocalDateTime(value: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function formatLocalMin(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface Props {
  profiles: Profile[];
}

const VARIABLES = [
  { token: "{{first_name}}", desc: "Recipient's first name (falls back to 'there')" },
  { token: "{{display_name}}", desc: "Recipient's full display name" },
  { token: "{{email}}", desc: "Recipient's email address" },
];

export default function MailerManager({ profiles }: Props) {
  const { toast } = useToast();
  const [mode, setMode] = useState<Mode>("single");
  const [filterPreset, setFilterPreset] = useState<FilterPreset>("paid");
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [ctaLabel, setCtaLabel] = useState("");
  const [ctaUrl, setCtaUrl] = useState("");
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduledFor, setScheduledFor] = useState<string>("");
  const [sending, setSending] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState<{
    total: number; suppressed: number; sendable: number; recipients: RecipientPreviewRow[];
  } | null>(null);

  const filteredProfiles = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return profiles.slice(0, 50);
    return profiles
      .filter((p) =>
        (p.email ?? "").toLowerCase().includes(q) ||
        (p.display_name ?? "").toLowerCase().includes(q),
      )
      .slice(0, 50);
  }, [profiles, search]);

  const filterPresetLabel: Record<FilterPreset, string> = {
    paid: "Paid users (any confirmed payment)",
    unpaid: "Unpaid users (no confirmed payment)",
    new_7d: "New users (signed up in last 7 days)",
    free_trial_used: "Users who used the free trial",
  };

  const toggleId = (id: string) => {
    if (mode === "single") setSelectedIds([id]);
    else setSelectedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  const recipientSummary = () => {
    if (mode === "single") return selectedIds.length === 1 ? "1 recipient" : "Pick 1 user";
    if (mode === "multiple") return `${selectedIds.length} recipient${selectedIds.length === 1 ? "" : "s"}`;
    if (mode === "filter") return `Filter: ${filterPresetLabel[filterPreset]}`;
    return `All users (${profiles.length})`;
  };

  const insertToken = (token: string) => {
    setBody((b) => `${b}${b && !b.endsWith(" ") ? " " : ""}${token}`);
  };

  const validate = (): string | null => {
    if (!subject.trim()) return "Subject is required";
    if (subject.length > SUBJECT_MAX) return `Subject must be ≤ ${SUBJECT_MAX} chars`;
    if (!body.trim()) return "Body is required";
    if (body.length > BODY_MAX) return `Body must be ≤ ${BODY_MAX} chars`;
    if (ctaLabel.trim() && !ctaUrl.trim()) return "CTA label requires a CTA URL";
    if (ctaUrl.trim() && !/^https:\/\//.test(ctaUrl.trim())) return "CTA URL must start with https://";
    if ((mode === "single" || mode === "multiple") && selectedIds.length === 0) return "Pick at least one recipient";
    if (mode === "single" && selectedIds.length > 1) return "Single mode allows only 1 recipient";
    if (scheduleEnabled) {
      if (!scheduledFor) return "Pick a date/time to schedule for";
      const parsed = parseLocalDateTime(scheduledFor);
      if (!parsed) return "Schedule date/time is invalid";
      if (parsed.getTime() < Date.now() + 30_000) return "Schedule must be at least 30 seconds in the future";
    }
    return null;
  };

  const buildPayload = (action: "preview" | "send" | "schedule", confirmAll = false) => ({
    action,
    subject: subject.trim(),
    body,
    ctaLabel: ctaLabel.trim() || undefined,
    ctaUrl: ctaUrl.trim() || undefined,
    recipientMode: mode,
    recipientUserIds: (mode === "single" || mode === "multiple") ? selectedIds : undefined,
    filterPreset: mode === "filter" ? filterPreset : undefined,
    scheduledFor:
      action === "schedule"
        ? parseLocalDateTime(scheduledFor)?.toISOString()
        : undefined,
    confirmAll,
  });


  const handlePreflight = async () => {
    const err = validate();
    if (err) { toast({ title: "Cannot send", description: err, variant: "destructive" }); return; }
    setSending(true);
    try {
      const { data, error } = await supabase.functions.invoke("admin-broadcast-email", {
        body: buildPayload("preview"),
      });
      if (error) throw error;
      setPreview(data as any);
      setPreviewOpen(true);
    } catch (e: any) {
      toast({ title: "Preview failed", description: e?.message ?? "Unknown error", variant: "destructive" });
    } finally { setSending(false); }
  };

  const handleConfirm = async () => {
    setSending(true);
    try {
      const action = scheduleEnabled ? "schedule" : "send";
      const { data, error } = await supabase.functions.invoke("admin-broadcast-email", {
        body: buildPayload(action, true),
      });
      const d = data as any;
      if (error) {
        // Try to extract the function's real error payload (enqueued/failed/error)
        const detail = d?.error || d?.message || error.message;
        const extras = d && typeof d.enqueued === "number"
          ? ` (${d.enqueued} sent, ${d.failed ?? 0} failed)`
          : "";
        throw new Error(`${detail}${extras}`);
      }
      if (action === "schedule") {
        toast({
          title: "Broadcast scheduled 📅",
          description: `Will send at ${new Date(d.scheduledFor).toLocaleString()}.`,
        });
      } else if (d?.queued) {
        toast({
          title: "Broadcast queued 🚀",
          description: `Sending to ${d.sendable} recipients in the background. Check History for progress.`,
        });
      } else {
        toast({
          title: "Broadcast sent ✅",
          description: `${d.enqueued} sent, ${d.suppressed} suppressed, ${d.failed ?? 0} failed.`,
        });
      }
      setSubject(""); setBody(""); setCtaLabel(""); setCtaUrl("");
      setSelectedIds([]); setPreview(null); setPreviewOpen(false);
      setScheduleEnabled(false); setScheduledFor("");
    } catch (e: any) {
      toast({ title: "Send failed", description: e?.message ?? "Unknown error", variant: "destructive" });
    } finally { setSending(false); }
  };

  const isAllOrLarge =
    mode === "all" || (preview ? preview.sendable >= ALL_USERS_CONFIRM_THRESHOLD : false);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-heading font-bold text-foreground">Mailer</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Send a branded EliteSwap email to one user, several users, or your whole list. Markdown + personalization supported.
        </p>
      </div>

      <Tabs defaultValue="compose" className="w-full">
        <TabsList>
          <TabsTrigger value="compose">Compose</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="compose" className="mt-6">
          <div className="grid lg:grid-cols-2 gap-6">
            <div className="space-y-4">
              {/* Recipients */}
              <div className="glass rounded-xl p-4 space-y-3">
                <Label className="font-heading text-sm">Recipients</Label>
                <Select value={mode} onValueChange={(v) => { setMode(v as Mode); setSelectedIds([]); }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="single">Single user</SelectItem>
                    <SelectItem value="multiple">Multiple users</SelectItem>
                    <SelectItem value="filter">Filter / segment</SelectItem>
                    <SelectItem value="all">All users</SelectItem>
                  </SelectContent>
                </Select>

                {(mode === "single" || mode === "multiple") && (
                  <>
                    <Input placeholder="Search by email or name..." value={search} onChange={(e) => setSearch(e.target.value)} />
                    <div className="max-h-56 overflow-y-auto border border-border rounded-lg divide-y divide-border">
                      {filteredProfiles.length === 0 && (
                        <div className="p-3 text-xs text-muted-foreground text-center">No users found.</div>
                      )}
                      {filteredProfiles.map((p) => {
                        const checked = selectedIds.includes(p.user_id);
                        return (
                          <button key={p.user_id} type="button" onClick={() => toggleId(p.user_id)}
                            className={`w-full text-left px-3 py-2 text-xs flex items-center justify-between hover:bg-muted/30 ${checked ? "bg-primary/10" : ""}`}>
                            <div className="min-w-0">
                              <div className="font-heading text-foreground truncate">{p.email ?? "(no email)"}</div>
                              {p.display_name && <div className="text-muted-foreground truncate">{p.display_name}</div>}
                            </div>
                            {checked && <Badge className="bg-primary/20 text-primary border-primary/30">Selected</Badge>}
                          </button>
                        );
                      })}
                    </div>
                    {selectedIds.length > 0 && (
                      <div className="text-xs text-muted-foreground font-heading">
                        {selectedIds.length} selected ·{" "}
                        <button onClick={() => setSelectedIds([])} className="text-primary hover:underline">Clear</button>
                      </div>
                    )}
                  </>
                )}

                {mode === "filter" && (
                  <Select value={filterPreset} onValueChange={(v) => setFilterPreset(v as FilterPreset)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(filterPresetLabel) as FilterPreset[]).map((k) => (
                        <SelectItem key={k} value={k}>{filterPresetLabel[k]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}

                {mode === "all" && (
                  <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 font-heading">
                    ⚠️ This will email every user with a profile email on file ({profiles.length}). You'll be asked to type <code>SEND ALL</code> to confirm.
                  </div>
                )}
              </div>

              {/* Composer */}
              <div className="glass rounded-xl p-4 space-y-3">
                <div>
                  <Label className="font-heading text-sm">Subject ({subject.length}/{SUBJECT_MAX})</Label>
                  <Input value={subject} maxLength={SUBJECT_MAX} onChange={(e) => setSubject(e.target.value)}
                    placeholder="Hi {{first_name}}, a quick update for you" />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <Label className="font-heading text-sm">Body — Markdown ({body.length}/{BODY_MAX})</Label>
                    <div className="flex gap-1 flex-wrap">
                      {VARIABLES.map((v) => (
                        <button key={v.token} type="button" onClick={() => insertToken(v.token)}
                          title={v.desc}
                          className="text-[10px] px-2 py-0.5 rounded bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20 font-mono">
                          {v.token}
                        </button>
                      ))}
                    </div>
                  </div>
                  <Textarea value={body} maxLength={BODY_MAX} onChange={(e) => setBody(e.target.value)}
                    placeholder={`## Welcome, {{first_name}}!\n\nWe just shipped something you'll love.\n\n- Point one\n- Point two\n\nThanks for being part of EliteSwap.`}
                    rows={10} className="font-mono text-xs" />
                  <p className="text-xs text-muted-foreground mt-1">
                    Personalization: <code>{"{{first_name}}"}</code>, <code>{"{{display_name}}"}</code>, <code>{"{{email}}"}</code>.
                    Markdown: <code>## heading</code>, <code>**bold**</code>, <code>*italic*</code>, <code>- bullets</code>, <code>[link](https://…)</code>.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="font-heading text-xs">CTA button label (optional)</Label>
                    <Input value={ctaLabel} onChange={(e) => setCtaLabel(e.target.value)} placeholder="Open dashboard" />
                  </div>
                  <div>
                    <Label className="font-heading text-xs">CTA button URL</Label>
                    <Input value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)} placeholder="https://eliteswap.online/dashboard" />
                  </div>
                </div>
              </div>

              {/* Schedule */}
              <div className="glass rounded-xl p-4 space-y-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={scheduleEnabled} onChange={(e) => {
                    setScheduleEnabled(e.target.checked);
                    if (!e.target.checked) setScheduledFor("");
                  }} />
                  <span className="font-heading text-sm flex items-center gap-1"><Clock className="w-3.5 h-3.5" /> Schedule for later</span>
                </label>
                {scheduleEnabled && (
                  <div>
                    <Label className="font-heading text-xs">Send at (your local time)</Label>
                    <Input type="datetime-local" value={scheduledFor}
                      min={formatLocalMin(new Date(Date.now() + 60_000))}
                      onChange={(e) => setScheduledFor(e.target.value)} />
                    <p className="text-xs text-muted-foreground mt-1">
                      A background job checks every minute and fires the broadcast at the chosen time.
                    </p>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between">
                <div className="text-xs text-muted-foreground font-heading">{recipientSummary()}</div>
                <Button onClick={handlePreflight} disabled={sending}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 font-heading">
                  {sending ? "Checking..." : (
                    <>{scheduleEnabled ? <CalendarIcon className="w-4 h-4 mr-1" /> : <Send className="w-4 h-4 mr-1" />}
                    Preview {scheduleEnabled ? "& schedule" : "& send"}</>
                  )}
                </Button>
              </div>
            </div>

            {/* RIGHT — live preview */}
            <div className="space-y-3">
              <Label className="font-heading text-sm text-muted-foreground">Live preview (tokens shown raw)</Label>
              <MailerPreview subject={subject} body={body} ctaLabel={ctaLabel} ctaUrl={ctaUrl} />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="history" className="mt-6">
          <BroadcastHistory />
        </TabsContent>
      </Tabs>

      <RecipientPreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        loading={sending}
        recipients={preview?.recipients ?? []}
        total={preview?.total ?? 0}
        suppressed={preview?.suppressed ?? 0}
        sendable={preview?.sendable ?? 0}
        isAllOrLarge={isAllOrLarge}
        requireTypedConfirm={isAllOrLarge}
        isScheduled={scheduleEnabled}
        scheduledFor={scheduleEnabled ? parseLocalDateTime(scheduledFor)?.toISOString() : undefined}
        onConfirm={handleConfirm}
      />
    </div>
  );
}

// -------- Live preview --------
function MailerPreview({ subject, body, ctaLabel, ctaUrl }: {
  subject: string; body: string; ctaLabel: string; ctaUrl: string;
}) {
  return (
    <div className="rounded-xl border border-border overflow-hidden bg-white text-black">
      <div className="px-6 py-5" style={{ background: "linear-gradient(135deg, #00FFFF 0%, #A64DFF 50%, #FF4DCB 100%)" }}>
        <div className="text-white text-lg font-bold tracking-wide">⚡ Elite Swap</div>
      </div>
      <div className="p-6 space-y-4">
        <h2 className="text-xl font-bold text-black">{subject || "Your subject preview"}</h2>
        <div className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
          {renderMarkdownPreview(body || "_Body preview will appear here_")}
        </div>
        {ctaLabel && ctaUrl && (
          <a href={ctaUrl} target="_blank" rel="noreferrer"
            className="inline-block px-5 py-2.5 rounded-lg text-white font-semibold text-sm"
            style={{ background: "linear-gradient(135deg, #A64DFF, #FF4DCB)" }}>
            {ctaLabel}
          </a>
        )}
      </div>
      <div className="px-6 py-4 bg-gray-50 border-t border-gray-200 text-xs text-gray-500">
        You're receiving this because you have an EliteSwap account.{" "}
        <span className="underline">Unsubscribe</span> · eliteswap.online
      </div>
    </div>
  );
}

function renderMarkdownPreview(src: string) {
  const lines = src.split("\n");
  const out: JSX.Element[] = [];
  let listBuf: string[] = [];
  const flushList = () => {
    if (listBuf.length) {
      out.push(<ul key={`l-${out.length}`} className="list-disc pl-5 space-y-1 my-2">
        {listBuf.map((li, i) => <li key={i}>{renderInline(li)}</li>)}
      </ul>);
      listBuf = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushList(); continue; }
    if (/^##\s+/.test(line)) {
      flushList();
      out.push(<h3 key={`h-${out.length}`} className="text-base font-bold text-black mt-4 mb-1">{renderInline(line.replace(/^##\s+/, ""))}</h3>);
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) { listBuf.push(bullet[1]); continue; }
    flushList();
    out.push(<p key={`p-${out.length}`} className="my-1">{renderInline(line)}</p>);
  }
  flushList();
  return out;
}

function renderInline(text: string): (string | JSX.Element)[] {
  const parts: (string | JSX.Element)[] = [text];
  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/;
  const boldRe = /\*\*([^*]+)\*\*/;
  const italicRe = /\*([^*]+)\*/;
  const expand = (re: RegExp, render: (m: RegExpExecArray, k: number) => JSX.Element) => {
    const next: (string | JSX.Element)[] = [];
    parts.forEach((p, idx) => {
      if (typeof p !== "string") { next.push(p); return; }
      let s = p; let m: RegExpExecArray | null; let k = 0;
      while ((m = re.exec(s))) {
        if (m.index > 0) next.push(s.slice(0, m.index));
        next.push(render(m, idx * 100 + k++));
        s = s.slice(m.index + m[0].length);
      }
      if (s) next.push(s);
    });
    parts.length = 0;
    parts.push(...next);
  };
  expand(linkRe, (m, k) => <a key={`a-${k}`} href={m[2]} className="text-purple-600 underline" target="_blank" rel="noreferrer">{m[1]}</a>);
  expand(boldRe, (m, k) => <strong key={`b-${k}`}>{m[1]}</strong>);
  expand(italicRe, (m, k) => <em key={`i-${k}`}>{m[1]}</em>);
  return parts;
}
