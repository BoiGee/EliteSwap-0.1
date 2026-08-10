import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Activity, Clock, Eye, RefreshCw, Search, User, Wifi, WifiOff } from "lucide-react";

interface Profile {
  user_id: string;
  email: string | null;
  display_name: string | null;
  created_at: string;
  last_seen_at?: string | null;
}

interface ActivityLog {
  id: string;
  user_id: string;
  action: string;
  page: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface Props {
  profiles: Profile[];
}

const ACTION_LABELS: Record<string, { label: string; icon: string; color: string }> = {
  page_visit: { label: "Page Visit", icon: "📄", color: "bg-blue-500/20 text-blue-400" },
  studio_connect: { label: "Studio Connected", icon: "🎬", color: "bg-primary/20 text-primary" },
  studio_disconnect: { label: "Studio Disconnected", icon: "⏹️", color: "bg-amber-500/20 text-amber-400" },
  payment_submitted: { label: "Payment Submitted", icon: "💰", color: "bg-green-500/20 text-green-400" },
  support_message: { label: "Support Message", icon: "💬", color: "bg-purple-500/20 text-purple-400" },
  tab_focus: { label: "Tab Focused", icon: "👁️", color: "bg-muted text-muted-foreground" },
  tab_blur: { label: "Tab Blurred", icon: "😴", color: "bg-muted text-muted-foreground" },
  session_end: { label: "Session Ended", icon: "🚪", color: "bg-destructive/20 text-destructive" },
  file_uploaded: { label: "File Uploaded", icon: "📎", color: "bg-cyan-500/20 text-cyan-400" },
};

function getPresenceStatus(lastSeen: string | null | undefined) {
  if (!lastSeen) return { status: "unknown", label: "Unknown", color: "text-muted-foreground" };
  const diff = Date.now() - new Date(lastSeen).getTime();
  if (diff < 2 * 60 * 1000) return { status: "online", label: "Online", color: "text-green-400" };
  if (diff < 5 * 60 * 1000) return { status: "away", label: "Away", color: "text-amber-400" };
  return { status: "offline", label: "Offline", color: "text-muted-foreground" };
}

function formatTimeSince(dateStr: string | null | undefined) {
  if (!dateStr) return "Never";
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60000) return "Just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

export default function ActivityManager({ profiles }: Props) {
  const [activities, setActivities] = useState<ActivityLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [presenceProfiles, setPresenceProfiles] = useState<Profile[]>([]);

  const fetchActivities = useCallback(async () => {
    setLoading(true);
    let query = supabase
      .from("user_activity_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);

    if (selectedUser) query = query.eq("user_id", selectedUser);
    if (actionFilter !== "all") query = query.eq("action", actionFilter);

    const { data } = await query;
    if (data) setActivities(data as ActivityLog[]);
    setLoading(false);
  }, [selectedUser, actionFilter]);

  const fetchPresence = useCallback(async () => {
    const { data } = await supabase
      .from("profiles")
      .select("user_id, email, display_name, created_at, last_seen_at")
      .order("last_seen_at", { ascending: false });
    if (data) setPresenceProfiles(data as Profile[]);
  }, []);

  useEffect(() => {
    fetchActivities();
    fetchPresence();
  }, [fetchActivities, fetchPresence]);

  // Auto-refresh every 30s
  useEffect(() => {
    const interval = setInterval(() => {
      fetchPresence();
    }, 30000);
    return () => clearInterval(interval);
  }, [fetchPresence]);

  const emailForUser = (userId: string) =>
    profiles.find((p) => p.user_id === userId)?.email ?? userId.slice(0, 8);

  const filteredProfiles = presenceProfiles.filter(
    (p) =>
      !search ||
      p.email?.toLowerCase().includes(search.toLowerCase()) ||
      p.display_name?.toLowerCase().includes(search.toLowerCase())
  );

  const onlineCount = presenceProfiles.filter(
    (p) => getPresenceStatus(p.last_seen_at).status === "online"
  ).length;
  const awayCount = presenceProfiles.filter(
    (p) => getPresenceStatus(p.last_seen_at).status === "away"
  ).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-heading font-bold text-foreground flex items-center gap-2">
          <Activity className="w-6 h-6" /> User Activity & Presence
        </h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => { fetchActivities(); fetchPresence(); }}
          className="font-heading text-xs"
        >
          <RefreshCw className={`w-3 h-3 mr-1 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {/* Presence Summary */}
      <div className="grid grid-cols-3 gap-4">
        <div className="glass neon-border rounded-xl p-4 text-center">
          <div className="flex items-center justify-center gap-2 mb-1">
            <Wifi className="w-4 h-4 text-green-400" />
            <span className="text-2xl font-heading font-bold text-green-400">{onlineCount}</span>
          </div>
          <p className="text-xs text-muted-foreground font-heading">Online Now</p>
        </div>
        <div className="glass neon-border rounded-xl p-4 text-center">
          <div className="flex items-center justify-center gap-2 mb-1">
            <Clock className="w-4 h-4 text-amber-400" />
            <span className="text-2xl font-heading font-bold text-amber-400">{awayCount}</span>
          </div>
          <p className="text-xs text-muted-foreground font-heading">Away</p>
        </div>
        <div className="glass neon-border rounded-xl p-4 text-center">
          <div className="flex items-center justify-center gap-2 mb-1">
            <WifiOff className="w-4 h-4 text-muted-foreground" />
            <span className="text-2xl font-heading font-bold text-muted-foreground">
              {presenceProfiles.length - onlineCount - awayCount}
            </span>
          </div>
          <p className="text-xs text-muted-foreground font-heading">Offline</p>
        </div>
      </div>

      {/* User Presence List */}
      <div className="glass neon-border rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-heading font-semibold text-foreground flex items-center gap-2">
            <User className="w-4 h-4" /> User Status
          </h3>
          <div className="relative w-48">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
            <Input
              placeholder="Search users..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-7 h-8 text-xs"
            />
          </div>
        </div>
        <div className="max-h-[300px] overflow-auto space-y-1">
          {filteredProfiles.map((p) => {
            const presence = getPresenceStatus(p.last_seen_at);
            return (
              <button
                key={p.user_id}
                onClick={() => setSelectedUser(selectedUser === p.user_id ? null : p.user_id)}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs transition-all ${
                  selectedUser === p.user_id
                    ? "bg-primary/10 neon-border"
                    : "bg-muted/20 hover:bg-muted/40"
                }`}
              >
                <span
                  className={`w-2 h-2 rounded-full ${
                    presence.status === "online"
                      ? "bg-green-400 animate-pulse"
                      : presence.status === "away"
                      ? "bg-amber-400"
                      : "bg-muted-foreground/40"
                  }`}
                />
                <span className="font-heading text-foreground flex-1 text-left truncate">
                  {p.email || p.display_name || p.user_id.slice(0, 8)}
                </span>
                <Badge variant="outline" className={`text-[10px] ${presence.color}`}>
                  {presence.label}
                </Badge>
                <span className="text-muted-foreground text-[10px]">
                  {formatTimeSince(p.last_seen_at)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Activity Log */}
      <div className="glass neon-border rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="font-heading font-semibold text-foreground flex items-center gap-2">
            <Eye className="w-4 h-4" /> Activity Log
            {selectedUser && (
              <Badge variant="secondary" className="text-[10px]">
                {emailForUser(selectedUser)}
                <button onClick={() => setSelectedUser(null)} className="ml-1 hover:text-destructive">✕</button>
              </Badge>
            )}
          </h3>
          <div className="flex gap-1 flex-wrap">
            {["all", "page_visit", "studio_connect", "studio_disconnect", "payment_submitted", "support_message"].map(
              (a) => (
                <button
                  key={a}
                  onClick={() => setActionFilter(a)}
                  className={`px-2 py-0.5 rounded-full text-[10px] font-heading transition-all ${
                    actionFilter === a
                      ? "bg-primary/20 text-primary neon-border"
                      : "bg-muted/30 text-muted-foreground hover:bg-muted/50"
                  }`}
                >
                  {a === "all" ? "All" : ACTION_LABELS[a]?.label || a}
                </button>
              )
            )}
          </div>
        </div>

        <div className="max-h-[400px] overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">User</TableHead>
                <TableHead className="text-xs">Action</TableHead>
                <TableHead className="text-xs">Page</TableHead>
                <TableHead className="text-xs">Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activities.map((a) => {
                const actionInfo = ACTION_LABELS[a.action] || {
                  label: a.action,
                  icon: "📌",
                  color: "bg-muted text-muted-foreground",
                };
                return (
                  <TableRow key={a.id}>
                    <TableCell className="text-xs text-muted-foreground font-heading">
                      {emailForUser(a.user_id)}
                    </TableCell>
                    <TableCell>
                      <span className={`text-[10px] font-heading font-semibold px-2 py-0.5 rounded-full ${actionInfo.color}`}>
                        {actionInfo.icon} {actionInfo.label}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs font-mono text-muted-foreground">
                      {a.page || "—"}
                    </TableCell>
                    <TableCell className="text-[10px] text-muted-foreground">
                      {new Date(a.created_at).toLocaleString()}
                    </TableCell>
                  </TableRow>
                );
              })}
              {activities.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-sm text-muted-foreground py-8">
                    No activity recorded yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
