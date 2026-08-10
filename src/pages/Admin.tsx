import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useAdmin } from "@/hooks/useAdmin";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { getSafeErrorMessage } from "@/lib/errors";
import PricingManager from "@/components/admin/PricingManager";
import UserManager from "@/components/admin/UserManager";
import PaymentManager from "@/components/admin/PaymentManager";
import SupportChatManager from "@/components/admin/SupportChatManager";
import ActivityManager from "@/components/admin/ActivityManager";
import ReviewManager from "@/components/admin/ReviewManager";
import FreeTrialManager from "@/components/admin/FreeTrialManager";
import DiscountManager from "@/components/admin/DiscountManager";
import MailerManager from "@/components/admin/MailerManager";
import PaymentFunnelManager from "@/components/admin/PaymentFunnelManager";
import PartnerManager from "@/components/admin/PartnerManager";
import FinanceManager from "@/components/admin/FinanceManager";
import LiveConnectionsManager from "@/components/admin/LiveConnectionsManager";
import UsageManager from "@/components/admin/UsageManager";
import PaidUsersManager from "@/components/admin/PaidUsersManager";
import DecartPoolManager from "@/components/admin/DecartPoolManager";
import KeyActivityManager from "@/components/admin/KeyActivityManager";
import AnnouncementManager from "@/components/admin/AnnouncementManager";
import AuditLogManager from "@/components/admin/AuditLogManager";
import AccountDeletionQueue from "@/components/admin/AccountDeletionQueue";
import BackupManager from "@/components/admin/BackupManager";
import ForumManager from "@/components/admin/ForumManager";
import TimeLedgerManager from "@/components/admin/TimeLedgerManager";
import { useSupportChatNotifications } from "@/hooks/useSupportChatNotifications";
import { notifyAdminPaymentEvent } from "@/lib/adminNotify";
import { isDevAdminOverrideEnabled } from "@/lib/devAdmin";
import NotificationBell from "@/components/NotificationBell";
import AdminAlertStatus from "@/components/admin/AdminAlertStatus";

interface Profile {
  user_id: string;
  email: string | null;
  display_name: string | null;
  created_at: string;
  terms_accepted_at: string | null;
  terms_version: string | null;
}

interface Payment {
  id: string;
  user_id: string;
  currency: string;
  amount_usd: number | null;
  tx_hash: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface ApiKey {
  id: string;
  user_id: string;
  key: string;
  label: string | null;
  is_active: boolean;
  created_at: string;
  expires_at: string | null;
}

interface UserRole {
  id: string;
  user_id: string;
  role: "admin" | "moderator" | "user";
}

interface FreeTrialAssignment {
  id: string;
  user_id: string;
  created_at: string;
}

type Tab = "analytics" | "payments" | "users" | "paid_users" | "api_keys" | "key_pool" | "key_activity" | "pricing" | "support" | "activity" | "reviews" | "free_trial" | "discounts" | "mailer" | "funnel" | "partners" | "finance" | "live" | "usage" | "time_ledger" | "announcements" | "deletions" | "backups" | "forum" | "audit";

export default function Admin() {
  const { user, signOut } = useAuth();
  const { isAdmin, isModerator, isSecAdmin, isStaff, canManagePayments, canManageDiscounts, loading: adminLoading } = useAdmin();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [tab, setTab] = useState<Tab>("analytics");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [userRoles, setUserRoles] = useState<UserRole[]>([]);
  const [freeTrialAssignments, setFreeTrialAssignments] = useState<FreeTrialAssignment[]>([]);
  const [editingKey, setEditingKey] = useState<ApiKey | null>(null);
  const [editKeyValue, setEditKeyValue] = useState("");
  const [editKeyLabel, setEditKeyLabel] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const { totalUnread: supportUnread } = useSupportChatNotifications();

  const fetchAll = useCallback(async () => {
    // Paginated fetch to bypass PostgREST's 1000-row default cap.
    const fetchAllPaginated = async <T,>(
      build: () => any,
      pageSize = 1000,
    ): Promise<T[]> => {
      const out: T[] = [];
      for (let from = 0; ; from += pageSize) {
        const { data, error } = await build().range(from, from + pageSize - 1);
        if (error) throw error;
        const rows = (data ?? []) as T[];
        out.push(...rows);
        if (rows.length < pageSize) break;
      }
      return out;
    };

    try {
      const [profilesAll, paymentsAll, keysAll, rolesAll, ftAll] = await Promise.all([
        fetchAllPaginated<Profile>(() => supabase.from("profiles").select("*").order("created_at", { ascending: false })),
        fetchAllPaginated<Payment>(() => supabase.from("payments").select("*").order("created_at", { ascending: false })),
        fetchAllPaginated<ApiKey>(() => supabase.from("api_keys").select("*").order("created_at", { ascending: false })),
        fetchAllPaginated<UserRole>(() => supabase.from("user_roles").select("*")),
        fetchAllPaginated<FreeTrialAssignment>(() => supabase.from("free_trial_assignments").select("id,user_id,created_at")),
      ]);
      setProfiles(profilesAll);
      setPayments(paymentsAll);
      setApiKeys(keysAll);
      setUserRoles(rolesAll as unknown as UserRole[]);
      setFreeTrialAssignments(ftAll as FreeTrialAssignment[]);
    } catch (e) {
      console.error('[internal] fetchAll failed', e);
    }
  }, []);

  useEffect(() => {
    if (isStaff) fetchAll();
  }, [isStaff, fetchAll]);

  // Keep the Overview tab's stats live: fetchAll() above only runs once on
  // mount (plus after the admin's own mutations), so without this, a
  // signup, a new payment, or a key getting deactivated on exhaustion —
  // none of which involve the admin doing anything — would never show up
  // until something else happened to trigger a refetch. That includes the
  // sidebar's pending-payments badge, which exists specifically to draw
  // attention to a payment the admin hasn't seen yet.
  useEffect(() => {
    if (!isStaff) return;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(fetchAll, 500);
    };
    const channel = supabase
      .channel("admin-overview-live")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "profiles" }, scheduleRefresh)
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "profiles" }, scheduleRefresh)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "payments" }, scheduleRefresh)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "payments" }, scheduleRefresh)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "api_keys" }, scheduleRefresh)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "api_keys" }, scheduleRefresh)
      .subscribe();
    return () => {
      if (debounce) clearTimeout(debounce);
      supabase.removeChannel(channel);
    };
  }, [isStaff, fetchAll]);

  const updatePaymentStatus = async (id: string, status: "confirmed" | "rejected") => {
    const pay = payments.find((p) => p.id === id);
    const { error } = await supabase.rpc("admin_set_payment_status" as any, {
      p_payment_id: id,
      p_status: status,
      p_plan_id: null,
      p_amount_usd: status === "confirmed" ? pay?.amount_usd ?? null : null,
    });
    if (error) {
      console.error('[Admin.updatePaymentStatus]', error);
      toast({
        title: "Error",
        description: `${getSafeErrorMessage(error.code)} — ${error.message}`,
        variant: "destructive",
      });
    } else {
      toast({ title: `Payment ${status}! ✅` });
      // Fire-and-forget admin alert.
      const prof = pay ? profiles.find((pr) => pr.user_id === pay.user_id) : undefined;
      notifyAdminPaymentEvent({
        paymentId: id,
        eventType: status === "confirmed" ? "admin_confirmed" : "admin_rejected",
        userEmail: prof?.email ?? null,
        userDisplayName: prof?.display_name ?? null,
        amountUsd: pay?.amount_usd ?? null,
        currency: pay?.currency ?? null,
        paymentMethod: (pay as any)?.payment_method ?? null,
        reference: pay?.tx_hash ?? null,
      });
      fetchAll();
    }
  };

  const toggleApiKey = async (id: string, is_active: boolean) => {
    const { error } = await supabase.from("api_keys").update({ is_active: !is_active }).eq("id", id);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      toast({ title: is_active ? "Key deactivated" : "Key activated" });
      fetchAll();
    }
  };

  const deleteApiKey = async (id: string) => {
    const { error } = await supabase.from("api_keys").delete().eq("id", id);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Key deleted 🗑️" });
      fetchAll();
    }
  };

  const openEditKey = (k: ApiKey) => {
    setEditingKey(k);
    setEditKeyValue(k.key);
    setEditKeyLabel(k.label ?? "");
  };

  const saveEditKey = async () => {
    if (!editingKey) return;
    const newKey = editKeyValue.trim();
    const newLabel = editKeyLabel.trim();
    if (!newKey) {
      toast({ title: "Key cannot be empty", variant: "destructive" });
      return;
    }
    setSavingEdit(true);
    const updates: { key?: string; label: string | null } = { label: newLabel || null };
    if (newKey !== editingKey.key) updates.key = newKey;
    const { error } = await supabase.from("api_keys").update(updates).eq("id", editingKey.id);
    setSavingEdit(false);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Key updated ✏️" });
      setEditingKey(null);
      fetchAll();
    }
  };

  if (adminLoading) {
    return <div className="min-h-screen flex items-center justify-center"><div className="text-primary animate-pulse font-heading text-xl">Loading...</div></div>;
  }

  const devAdminOverrideEnabled = isDevAdminOverrideEnabled(window.location.search);

  if (!isStaff && !devAdminOverrideEnabled) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="glass neon-border rounded-2xl p-8 text-center space-y-4 max-w-sm">
          <h1 className="text-2xl font-heading font-bold text-destructive">Access Denied</h1>
          <p className="text-sm text-muted-foreground">You don't have admin privileges.</p>
          <Button onClick={() => navigate("/dashboard")} variant="outline" className="font-heading">Back to Dashboard</Button>
        </div>
      </div>
    );
  }

  const totalUsers = profiles.length;
  const pendingPayments = payments.filter((p) => p.status === "pending").length;
  const confirmedPayments = payments.filter((p) => p.status === "confirmed").length;
  const activeKeys = apiKeys.filter((k) => k.is_active).length;

  // Base moderator tabs (read-only + forum/support).
  const MODERATOR_TABS: Tab[] = ["analytics", "users", "live", "usage", "key_activity", "announcements", "support", "activity", "forum"];

  const allTabs: { id: Tab; label: string; icon: string }[] = [
    { id: "analytics", label: "Overview", icon: "📊" },
    { id: "finance", label: "Finance", icon: "📈" },
    { id: "users", label: "Users", icon: "👥" },
    { id: "paid_users", label: "Paid Users", icon: "💎" },
    { id: "live", label: "Live", icon: "🟢" },
    { id: "usage", label: "Usage", icon: "⏱️" },
    { id: "time_ledger", label: "Time Ledger", icon: "🧮" },
    { id: "payments", label: "Payments", icon: "💰" },
    { id: "funnel", label: "Funnel", icon: "🎯" },
    { id: "api_keys", label: "API Keys", icon: "🔑" },
    { id: "key_pool", label: "Decart Pool", icon: "🗝️" },
    { id: "key_activity", label: "Key Activity", icon: "📜" },
    { id: "pricing", label: "Pricing", icon: "💎" },
    { id: "partners", label: "Partners", icon: "🤝" },
    { id: "reviews", label: "Reviews", icon: "⭐" },
    { id: "free_trial", label: "Free Trial", icon: "🎁" },
    { id: "discounts", label: "Discounts", icon: "🏷️" },
    { id: "mailer", label: "Mailer", icon: "✉️" },
    { id: "announcements", label: "Announcements", icon: "📢" },
    { id: "deletions", label: "Deletions", icon: "🗑️" },
    { id: "backups", label: "Backups", icon: "💾" },
    { id: "support", label: "Support", icon: "💬" },
    { id: "activity", label: "Activity", icon: "📡" },
    { id: "forum", label: "Forum", icon: "🗣️" },
    { id: "audit", label: "Audit Log", icon: "🔍" },
  ];

  // Compute the allowed tab set for the current role.
  const allowedTabIds: Set<Tab> = (() => {
    if (isAdmin) return new Set(allTabs.map((t) => t.id));
    const allowed = new Set<Tab>(MODERATOR_TABS);
    if (canManagePayments || isSecAdmin) {
      allowed.add("payments");
      allowed.add("paid_users");
      allowed.add("funnel");
    }
    if (canManageDiscounts || isSecAdmin) allowed.add("discounts");
    if (isSecAdmin) allowed.add("audit");
    // Finance + Time Ledger are admin-only. Never surface them to sec_admin or moderator.
    allowed.delete("finance");
    allowed.delete("time_ledger");
    return allowed;
  })();

  const tabs = allTabs.filter((t) => allowedTabIds.has(t.id));

  // If a staff member somehow lands on a forbidden tab, snap back to overview.
  if (!allowedTabIds.has(tab)) {
    setTab("analytics");
  }

  const emailForUser = (userId: string) => profiles.find((p) => p.user_id === userId)?.email ?? userId.slice(0, 8);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border glass px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-heading font-bold gradient-text">Elite Swap</h1>
          <span className={`text-xs px-2 py-0.5 rounded-full font-heading font-semibold ${isAdmin ? "bg-destructive/20 text-destructive" : isSecAdmin ? "bg-amber-500/20 text-amber-400" : "bg-primary/20 text-primary"}`}>{isAdmin ? "ADMIN" : isSecAdmin ? "SEC ADMIN" : "MODERATOR"}</span>
        </div>
        <div className="flex items-center gap-3">
          <NotificationBell />
          <span className="text-xs text-muted-foreground font-heading">{user?.email}</span>
          <Button variant="outline" size="sm" onClick={() => navigate("/dashboard")} className="font-heading text-xs">Dashboard</Button>
          <Button variant="outline" size="sm" onClick={async () => { await signOut(); navigate("/"); }} className="font-heading text-xs">Sign Out</Button>
        </div>
      </header>

      <div className="px-4 py-2 border-b border-border/60 bg-background/40">
        <AdminAlertStatus />
      </div>



      <div className="flex-1 flex">
        <nav className="w-48 border-r border-border glass p-3 space-y-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm font-heading transition-all flex items-center gap-2 ${
                tab === t.id ? "bg-primary/10 text-primary neon-border" : "text-muted-foreground hover:bg-muted/30"
              }`}
            >
              <span>{t.icon}</span>
              {t.label}
              {t.id === "payments" && pendingPayments > 0 && (
                <span className="ml-auto bg-amber-500/20 text-amber-400 text-xs px-1.5 py-0.5 rounded-full font-semibold">{pendingPayments}</span>
              )}
              {t.id === "support" && supportUnread > 0 && tab !== "support" && (
                <span className="ml-auto min-w-[20px] h-5 px-1 bg-destructive text-destructive-foreground text-xs rounded-full font-semibold flex items-center justify-center">
                  {supportUnread > 99 ? "99+" : supportUnread}
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className="flex-1 p-6 overflow-auto">
          {tab === "analytics" && (
            <div className="space-y-6">
              <h2 className="text-2xl font-heading font-bold text-foreground">Dashboard Overview</h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { label: "Total Users", value: totalUsers, icon: "👥" },
                  { label: "Pending Payments", value: pendingPayments, icon: "⏳" },
                  { label: "Confirmed Payments", value: confirmedPayments, icon: "✅" },
                  { label: "Active API Keys", value: activeKeys, icon: "🔑" },
                ].map((s) => (
                  <div key={s.label} className="glass neon-border rounded-xl p-4 text-center space-y-2">
                    <div className="text-2xl">{s.icon}</div>
                    <div className="text-3xl font-heading font-bold text-foreground">{s.value}</div>
                    <div className="text-xs text-muted-foreground font-heading">{s.label}</div>
                  </div>
                ))}
              </div>

              <div className="glass neon-border rounded-xl p-4 space-y-3">
                <h3 className="font-heading font-semibold text-foreground">Recent Payments</h3>
                {payments.slice(0, 5).map((p) => (
                  <div key={p.id} className="flex items-center justify-between bg-muted/20 rounded-lg px-3 py-2 text-xs">
                    <span className="text-muted-foreground">{emailForUser(p.user_id)}</span>
                    <span className="font-heading font-semibold">{p.currency}</span>
                    <span className="font-mono truncate max-w-[120px]">{p.tx_hash}</span>
                    <span className={`font-heading font-semibold px-2 py-0.5 rounded-full ${
                      p.status === "confirmed" ? "bg-primary/20 text-primary" :
                      p.status === "rejected" ? "bg-destructive/20 text-destructive" :
                      "bg-amber-500/20 text-amber-400"
                    }`}>{p.status}</span>
                  </div>
                ))}
                {payments.length === 0 && <p className="text-sm text-muted-foreground">No payments yet.</p>}
              </div>
            </div>
          )}

          {tab === "users" && (
            <UserManager
              profiles={profiles}
              payments={payments}
              apiKeys={apiKeys}
              userRoles={userRoles}
              freeTrialAssignments={freeTrialAssignments}
              onRefresh={fetchAll}
            />
          )}

          {tab === "payments" && (
            <PaymentManager
              payments={payments}
              profiles={profiles}
              onUpdateStatus={updatePaymentStatus}
              onRefresh={fetchAll}
            />
          )}

          {tab === "api_keys" && (
            <div className="space-y-4">
              <h2 className="text-2xl font-heading font-bold text-foreground">Manage API Keys</h2>
              <div className="space-y-2">
                {apiKeys.map((k) => (
                  <div key={k.id} className="glass rounded-xl px-4 py-3 flex items-center gap-4 text-sm">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-muted-foreground font-heading">{emailForUser(k.user_id)}</div>
                      <div className="text-xs font-heading text-foreground/80 mt-1">{k.label || "—"}</div>
                      <div className="font-mono text-xs text-foreground/70 truncate mt-1">{k.key}</div>
                      <div className="text-xs text-muted-foreground mt-1">{new Date(k.created_at).toLocaleString()}</div>
                    </div>
                    <span className={`text-xs font-heading font-semibold px-2 py-0.5 rounded-full ${k.is_active ? "bg-primary/20 text-primary" : "bg-destructive/20 text-destructive"}`}>
                      {k.is_active ? "Active" : "Inactive"}
                    </span>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" onClick={() => openEditKey(k)} className="font-heading text-xs">
                        Edit
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => toggleApiKey(k.id, k.is_active)} className="font-heading text-xs">
                        {k.is_active ? "Deactivate" : "Activate"}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => deleteApiKey(k.id)} className="border-destructive/30 text-destructive hover:bg-destructive/10 font-heading text-xs">
                        Delete
                      </Button>
                    </div>
                  </div>
                ))}
                {apiKeys.length === 0 && <p className="text-sm text-muted-foreground">No API keys yet.</p>}
              </div>
            </div>
          )}

          {tab === "pricing" && <PricingManager />}

          {tab === "key_pool" && <DecartPoolManager />}

          {tab === "key_activity" && <KeyActivityManager />}

          {tab === "announcements" && <AnnouncementManager />}

          {tab === "deletions" && <AccountDeletionQueue />}

          {tab === "backups" && <BackupManager />}

          {tab === "forum" && <ForumManager />}

          {tab === "partners" && <PartnerManager profiles={profiles} onRefresh={fetchAll} />}

          {tab === "funnel" && <PaymentFunnelManager />}

          {tab === "reviews" && <ReviewManager emailForUser={emailForUser} />}

          {tab === "free_trial" && <FreeTrialManager emailForUser={emailForUser} />}

          {tab === "discounts" && <DiscountManager emailForUser={emailForUser} />}

          {tab === "mailer" && <MailerManager profiles={profiles} />}

          {tab === "support" && <SupportChatManager profiles={profiles} />}

          {tab === "activity" && <ActivityManager profiles={profiles} />}

          {tab === "live" && <LiveConnectionsManager />}

          {tab === "usage" && <UsageManager />}

          {tab === "time_ledger" && <TimeLedgerManager />}

          {tab === "finance" && <FinanceManager />}

          {tab === "paid_users" && <PaidUsersManager profiles={profiles} payments={payments} />}

          {tab === "audit" && <AuditLogManager />}
        </div>
      </div>

      <Dialog open={!!editingKey} onOpenChange={(o) => !o && setEditingKey(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-heading">Edit API Key</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="edit-key-label" className="font-heading text-xs">Label</Label>
              <Input id="edit-key-label" value={editKeyLabel} onChange={(e) => setEditKeyLabel(e.target.value)} placeholder="Default" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-key-value" className="font-heading text-xs">Key</Label>
              <Input id="edit-key-value" value={editKeyValue} onChange={(e) => setEditKeyValue(e.target.value)} className="font-mono text-xs" />
              <p className="text-xs text-muted-foreground">Changing the key value invalidates the previous one for the user.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingKey(null)} className="font-heading">Cancel</Button>
            <Button onClick={saveEditKey} disabled={savingEdit} className="font-heading">{savingEdit ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
