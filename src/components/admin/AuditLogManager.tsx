import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getSafeErrorMessage } from "@/lib/errors";

const PAGE_SIZE = 50;

interface AuditLog {
  id: string;
  actor_id: string | null;
  actor_email: string | null;
  actor_role: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  before_data: any;
  after_data: any;
  metadata: any;
  created_at: string;
}

const ACTION_OPTIONS = [
  { value: "all", label: "All actions" },
  { value: "payments.create", label: "Payment created" },
  { value: "payments.update", label: "Payment updated" },
  { value: "payments.status", label: "Payment status change" },
  { value: "discount_codes", label: "Discount codes" },
  { value: "user_roles", label: "User roles" },
  { value: "api_keys", label: "Unique keys" },
  { value: "pricing_plans", label: "Pricing plans" },
];

const ROLE_OPTIONS = [
  { value: "all", label: "All roles" },
  { value: "admin", label: "Admin" },
  { value: "sec_admin", label: "Sec Admin" },
  { value: "moderator", label: "Moderator" },
  { value: "system", label: "System" },
  { value: "user", label: "User" },
];

export default function AuditLogManager() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [count, setCount] = useState(0);
  const [search, setSearch] = useState("");
  const [actionFilter, setActionFilter] = useState("all");
  const [roleFilter, setRoleFilter] = useState("all");
  const [selected, setSelected] = useState<AuditLog | null>(null);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      let query = supabase
        .from("admin_audit_logs")
        .select("*", { count: "exact" })
        .order("created_at", { ascending: false });

      if (search.trim()) {
        const term = search.trim().toLowerCase();
        query = query.or(
          `actor_email.ilike.%${term}%,action.ilike.%${term}%,target_id.ilike.%${term}%`
        );
      }

      if (actionFilter !== "all") {
        if (actionFilter === "payments.status") {
          query = query.ilike("action", "payments.status.%");
        } else if (actionFilter === "payments.create" || actionFilter === "payments.update") {
          query = query.eq("action", actionFilter);
        } else {
          query = query.or(`action.eq.${actionFilter},action.ilike.${actionFilter}.%`);
        }
      }

      if (roleFilter !== "all") {
        query = query.eq("actor_role", roleFilter);
      }

      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      query = query.range(from, to);

      const { data, error, count: total } = await query;
      if (error) throw error;
      setLogs(data || []);
      setCount(total || 0);
    } catch (e) {
      toast({
        title: "Error loading audit log",
        description: getSafeErrorMessage(e),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [page, search, actionFilter, roleFilter, toast]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const totalPages = Math.ceil(count / PAGE_SIZE) || 1;

  const formatAction = (action: string) => {
    return action.replace(/\./g, " → ");
  };

  const roleBadge = (role: string | null) => {
    const r = role || "unknown";
    const colors: Record<string, string> = {
      admin: "bg-destructive/20 text-destructive",
      sec_admin: "bg-amber-500/20 text-amber-400",
      moderator: "bg-primary/20 text-primary",
      system: "bg-muted text-muted-foreground",
      user: "bg-muted text-muted-foreground",
    };
    return (
      <span className={`text-xs px-2 py-0.5 rounded-full font-heading ${colors[r] || colors.user}`}>
        {r}
      </span>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-heading font-bold text-foreground">Audit Log</h2>
        <span className="text-xs text-muted-foreground">{count} total events</span>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="flex-1 min-w-[200px]">
          <Label className="text-xs font-heading">Search</Label>
          <Input
            placeholder="Actor email, action, target ID..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            className="text-sm"
          />
        </div>
        <div className="w-48">
          <Label className="text-xs font-heading">Action</Label>
          <Select value={actionFilter} onValueChange={(v) => { setActionFilter(v); setPage(0); }}>
            <SelectTrigger className="text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACTION_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value} className="text-sm">
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-40">
          <Label className="text-xs font-heading">Role</Label>
          <Select value={roleFilter} onValueChange={(v) => { setRoleFilter(v); setPage(0); }}>
            <SelectTrigger className="text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value} className="text-sm">
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="glass rounded-xl overflow-hidden">
        <div className="max-h-[600px] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted/80 backdrop-blur text-left font-heading text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Time</th>
                <th className="px-4 py-3">Actor</th>
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">Target</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id} className="border-t border-border/50 hover:bg-muted/30">
                  <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(log.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      <span className="text-xs text-foreground">{log.actor_email || "system"}</span>
                      {roleBadge(log.actor_role)}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-medium">{formatAction(log.action)}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {log.target_type}:{log.target_id?.slice(0, 8)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-xs"
                      onClick={() => setSelected(log)}
                    >
                      Details
                    </Button>
                  </td>
                </tr>
              ))}
              {logs.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground text-sm">
                    No audit events found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          size="sm"
          disabled={page === 0 || loading}
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          className="text-xs"
        >
          Previous
        </Button>
        <span className="text-xs text-muted-foreground">
          Page {page + 1} of {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= totalPages - 1 || loading}
          onClick={() => setPage((p) => p + 1)}
          className="text-xs"
        >
          Next
        </Button>
      </div>

      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-auto">
          <DialogHeader>
            <DialogTitle className="font-heading">Audit Details</DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-4 text-xs">
                <div><span className="text-muted-foreground">Action:</span> {selected.action}</div>
                <div><span className="text-muted-foreground">Time:</span> {new Date(selected.created_at).toLocaleString()}</div>
                <div><span className="text-muted-foreground">Actor:</span> {selected.actor_email || "system"} ({selected.actor_role})</div>
                <div><span className="text-muted-foreground">Target:</span> {selected.target_type}:{selected.target_id}</div>
              </div>
              <div className="space-y-2">
                <h4 className="font-heading text-xs text-muted-foreground">Before</h4>
                <pre className="bg-muted/50 p-3 rounded-lg text-xs overflow-auto">
                  {selected.before_data ? JSON.stringify(selected.before_data, null, 2) : "(created)"}
                </pre>
              </div>
              <div className="space-y-2">
                <h4 className="font-heading text-xs text-muted-foreground">After</h4>
                <pre className="bg-muted/50 p-3 rounded-lg text-xs overflow-auto">
                  {selected.after_data ? JSON.stringify(selected.after_data, null, 2) : "(deleted)"}
                </pre>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
