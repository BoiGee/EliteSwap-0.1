import { useState, useMemo, useEffect, useCallback } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useAdmin } from "@/hooks/useAdmin";
import { getSafeErrorMessage } from "@/lib/errors";
import { notifyAdminPaymentEvent } from "@/lib/adminNotify";
import UserDetailDrawer from "./UserDetailDrawer";
import { TERMS_VERSION } from "@/lib/termsContent";

interface Profile {
  user_id: string;
  email: string | null;
  display_name: string | null;
  created_at: string;
  terms_accepted_at?: string | null;
  terms_version?: string | null;
}

interface Payment {
  id: string;
  user_id: string;
  currency: string;
  amount_usd: number | null;
  tx_hash: string | null;
  status: string;
  created_at: string;
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
  role: "admin" | "sec_admin" | "moderator" | "user";
}

interface FreeTrialAssignment {
  id: string;
  user_id: string;
  created_at: string;
}

interface Props {
  profiles: Profile[];
  payments: Payment[];
  apiKeys: ApiKey[];
  userRoles: UserRole[];
  freeTrialAssignments?: FreeTrialAssignment[];
  onRefresh: () => void;
}

type PaymentStatusFilter = "all" | "paid" | "pending" | "failed" | "attempted" | "never";
type SuccessfulFilter = "any" | "0" | "1" | "2plus";
type UnsuccessfulFilter = "any" | "rejected" | "stale_review" | "none";
type MethodFilter = "all" | "crypto" | "none";
type AgeFilter = "all" | "new24h" | "week" | "month" | "older30" | "older90";
type ActivityFilter = "all" | "active" | "idle" | "dormant";
type KeysFilter = "all" | "active_key" | "no_active_key" | "expired_key" | "free_trial_used";
type RoleFilter = "all" | "admin" | "moderator" | "user_only";
type TermsFilter = "all" | "accepted" | "pending";
type SortKey = "newest" | "oldest" | "most_paid" | "most_payments" | "most_active" | "email_asc";

const DAY_MS = 86_400_000;

export default function UserManager({ profiles, payments, apiKeys, userRoles, freeTrialAssignments = [], onRefresh }: Props) {
  const { toast } = useToast();
  const { isAdmin, canManagePayments } = useAdmin();
  const [search, setSearch] = useState("");
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatusFilter>("all");
  const [successful, setSuccessful] = useState<SuccessfulFilter>("any");
  const [unsuccessful, setUnsuccessful] = useState<UnsuccessfulFilter>("any");
  const [method, setMethod] = useState<MethodFilter>("all");
  const [age, setAge] = useState<AgeFilter>("all");
  const [activity, setActivity] = useState<ActivityFilter>("all");
  const [keysFilter, setKeysFilter] = useState<KeysFilter>("all");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [termsFilter, setTermsFilter] = useState<TermsFilter>("all");
  const [sort, setSort] = useState<SortKey>("newest");
  const [staleHours, setStaleHours] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem("admin-stale-review-hours"));
      return Number.isFinite(v) && v >= 1 && v <= 720 ? v : 24;
    } catch { return 24; }
  });
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  const [detailUserId, setDetailUserId] = useState<string | null>(null);
  const [newKeyLabel, setNewKeyLabel] = useState("");
  const [newKeySecret, setNewKeySecret] = useState("");
  const [editingKey, setEditingKey] = useState<ApiKey | null>(null);
  const [editKeyValue, setEditKeyValue] = useState("");
  const [editKeyLabel, setEditKeyLabel] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [newKeyHours, setNewKeyHours] = useState("");
  const [newKeyMinutes, setNewKeyMinutes] = useState("");
  const [newKeySeconds, setNewKeySeconds] = useState("");
  const [creatingKey, setCreatingKey] = useState(false);
  const [customHours, setCustomHours] = useState("");
  const [customMinutes, setCustomMinutes] = useState("");
  const [customSeconds, setCustomSeconds] = useState("");
  const [editingProfile, setEditingProfile] = useState<string | null>(null);
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [newPaymentUserId, setNewPaymentUserId] = useState<string | null>(null);
  const [newPaymentCurrency, setNewPaymentCurrency] = useState<"BTC" | "BNB" | "USDT-BEP20" | "USDT-TRC20">("BTC");
  const [newPaymentTxHash, setNewPaymentTxHash] = useState("");
  const [newPaymentAmount, setNewPaymentAmount] = useState("");
  const [newPaymentStatus, setNewPaymentStatus] = useState<"pending" | "confirmed" | "rejected">("confirmed");
  const [partnersList, setPartnersList] = useState<Array<{ id: string; code: string; display_name: string | null }>>([]);
  const [attributions, setAttributions] = useState<Record<string, string>>({}); // user_id -> partner_id
  const [partnerSelections, setPartnerSelections] = useState<Record<string, string>>({}); // user_id -> selected partner_id (or "__none__")
  const [savingPartnerFor, setSavingPartnerFor] = useState<string | null>(null);

  const fetchPartnersAndAttributions = useCallback(async () => {
    const [{ data: parts }, { data: attrs }] = await Promise.all([
      supabase.from("partners" as any).select("id, code, display_name, is_active").eq("is_active", true).order("code"),
      supabase.from("partner_attributions" as any).select("user_id, partner_id"),
    ]);
    if (parts) setPartnersList(parts as any);
    if (attrs) {
      const map: Record<string, string> = {};
      for (const a of attrs as any[]) map[a.user_id] = a.partner_id;
      setAttributions(map);
    }
  }, []);

  useEffect(() => { fetchPartnersAndAttributions(); }, [fetchPartnersAndAttributions]);

  const setUserPartner = async (userId: string) => {
    const sel = partnerSelections[userId] ?? attributions[userId] ?? "__none__";
    setSavingPartnerFor(userId);
    const { error } = await supabase.rpc("admin_set_partner_for_user" as any, {
      p_user_id: userId,
      p_partner_id: sel === "__none__" ? null : sel,
    });
    setSavingPartnerFor(null);
    if (error) {
      console.error("[internal]", error);
      toast({ title: "Error", description: getSafeErrorMessage(error.code), variant: "destructive" });
    } else {
      toast({ title: sel === "__none__" ? "Partner removed ✅" : "User assigned to partner ✅" });
      await fetchPartnersAndAttributions();
    }
  };

  // Per-user derived stats (single pass)
  const userStats = useMemo(() => {
    const now = Date.now();
    const map: Record<string, {
      confirmedCount: number;
      rejectedCount: number;
      pendingCount: number;
      pendingReviewStaleCount: number;
      totalUsd: number;
      lastPaymentAt: number;
      methods: Set<string>;
      hasActiveKey: boolean;
      hasExpiredKey: boolean;
      usedFreeTrial: boolean;
      ageDays: number;
      daysSinceSeen: number;
    }> = {};
    for (const p of profiles) {
      map[p.user_id] = {
        confirmedCount: 0,
        rejectedCount: 0,
        pendingCount: 0,
        pendingReviewStaleCount: 0,
        totalUsd: 0,
        lastPaymentAt: 0,
        methods: new Set(),
        hasActiveKey: false,
        hasExpiredKey: false,
        usedFreeTrial: false,
        ageDays: Math.floor((now - new Date(p.created_at).getTime()) / DAY_MS),
        daysSinceSeen: (p as any).last_seen_at
          ? Math.floor((now - new Date((p as any).last_seen_at).getTime()) / DAY_MS)
          : Infinity,
      };
    }
    for (const pay of payments) {
      const s = map[pay.user_id];
      if (!s) continue;
      const created = new Date(pay.created_at).getTime();
      if (pay.status === "confirmed") {
        s.confirmedCount++;
        s.totalUsd += Number(pay.amount_usd ?? 0);
      } else if (pay.status === "rejected") {
        s.rejectedCount++;
      } else if (pay.status === "pending") {
        s.pendingCount++;
      } else if (pay.status === "pending_review") {
        s.pendingCount++;
        if (now - created > staleHours * 3_600_000) s.pendingReviewStaleCount++;
      }
      if (created > s.lastPaymentAt) s.lastPaymentAt = created;
      const m = (pay as any).payment_method ?? "crypto";
      s.methods.add(m);
    }
    for (const k of apiKeys) {
      const s = map[k.user_id];
      if (!s) continue;
      const expired = k.expires_at && new Date(k.expires_at).getTime() <= now;
      if (k.is_active && !expired) s.hasActiveKey = true;
      if (expired) s.hasExpiredKey = true;
    }
    for (const ft of freeTrialAssignments) {
      const s = map[ft.user_id];
      if (s) s.usedFreeTrial = true;
    }
    return map;
  }, [profiles, payments, apiKeys, freeTrialAssignments, staleHours]);

  const totalRevenue = useMemo(
    () => payments.filter((p) => p.status === "confirmed").reduce((sum, p) => sum + Number(p.amount_usd ?? 0), 0),
    [payments]
  );

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    const list = profiles.filter((p) => {
      if (q && !(
        p.email?.toLowerCase().includes(q) ||
        p.display_name?.toLowerCase().includes(q) ||
        p.user_id.includes(q)
      )) return false;

      const s = userStats[p.user_id];
      if (!s) return false;

      // Payment status
      if (paymentStatus === "paid" && s.confirmedCount === 0) return false;
      if (paymentStatus === "pending" && s.pendingCount === 0) return false;
      if (paymentStatus === "failed" && s.rejectedCount === 0) return false;
      if (paymentStatus === "attempted" && s.confirmedCount + s.pendingCount + s.rejectedCount === 0) return false;
      if (paymentStatus === "never" && s.confirmedCount + s.pendingCount + s.rejectedCount > 0) return false;

      // Successful count
      if (successful === "0" && s.confirmedCount !== 0) return false;
      if (successful === "1" && s.confirmedCount !== 1) return false;
      if (successful === "2plus" && s.confirmedCount < 2) return false;

      // Unsuccessful
      if (unsuccessful === "rejected" && s.rejectedCount === 0) return false;
      if (unsuccessful === "stale_review" && s.pendingReviewStaleCount === 0) return false;
      if (unsuccessful === "none" && (s.rejectedCount > 0 || s.pendingReviewStaleCount > 0)) return false;

      // Method
      const hasCrypto = s.methods.has("crypto");
      if (method === "crypto" && !hasCrypto) return false;
      if (method === "none" && s.methods.size > 0) return false;

      // Account age
      if (age === "new24h" && s.ageDays >= 1) return false;
      if (age === "week" && s.ageDays > 7) return false;
      if (age === "month" && s.ageDays > 30) return false;
      if (age === "older30" && s.ageDays <= 30) return false;
      if (age === "older90" && s.ageDays <= 90) return false;

      // Activity
      if (activity === "active" && s.daysSinceSeen >= 7) return false;
      if (activity === "idle" && (s.daysSinceSeen < 7 || s.daysSinceSeen > 30)) return false;
      if (activity === "dormant" && s.daysSinceSeen <= 30) return false;

      // Keys
      if (keysFilter === "active_key" && !s.hasActiveKey) return false;
      if (keysFilter === "no_active_key" && s.hasActiveKey) return false;
      if (keysFilter === "expired_key" && !s.hasExpiredKey) return false;
      if (keysFilter === "free_trial_used" && !s.usedFreeTrial) return false;

      // Role
      const roles = userRoles.filter((r) => r.user_id === p.user_id).map((r) => r.role);
      if (roleFilter === "admin" && !roles.includes("admin")) return false;
      if (roleFilter === "moderator" && !roles.includes("moderator")) return false;
      if (roleFilter === "user_only" && (roles.includes("admin") || roles.includes("moderator"))) return false;

      // Terms acceptance
      const termsOk = !!p.terms_accepted_at && p.terms_version === TERMS_VERSION;
      if (termsFilter === "accepted" && !termsOk) return false;
      if (termsFilter === "pending" && termsOk) return false;

      return true;
    });

    // Sort
    const sorted = [...list];
    sorted.sort((a, b) => {
      const sa = userStats[a.user_id];
      const sb = userStats[b.user_id];
      switch (sort) {
        case "oldest": return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        case "most_paid": return sb.totalUsd - sa.totalUsd;
        case "most_payments": return sb.confirmedCount - sa.confirmedCount;
        case "most_active": return sa.daysSinceSeen - sb.daysSinceSeen;
        case "email_asc": return (a.email ?? "").localeCompare(b.email ?? "");
        case "newest":
        default:
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }
    });
    return sorted;
  }, [profiles, userStats, userRoles, search, paymentStatus, successful, unsuccessful, method, age, activity, keysFilter, roleFilter, termsFilter, sort, staleHours]);

  const filteredPaidCount = useMemo(
    () => filtered.filter((p) => userStats[p.user_id]?.confirmedCount > 0).length,
    [filtered, userStats]
  );
  const filteredRevenue = useMemo(
    () => filtered.reduce((sum, p) => sum + (userStats[p.user_id]?.totalUsd ?? 0), 0),
    [filtered, userStats]
  );

  const resetFilters = () => {
    setSearch("");
    setPaymentStatus("all");
    setSuccessful("any");
    setUnsuccessful("any");
    setMethod("all");
    setAge("all");
    setActivity("all");
    setKeysFilter("all");
    setRoleFilter("all");
    setTermsFilter("all");
    setSort("newest");
  };

  // Quick filter chip presets
  type ChipKey = "paid" | "new_today" | "pending" | "failed" | "active_week" | "free_trial";
  const activeChip: ChipKey | null = (() => {
    if (paymentStatus === "paid" && successful === "any" && unsuccessful === "any" && method === "all" && age === "all" && activity === "all" && keysFilter === "all" && roleFilter === "all") return "paid";
    if (paymentStatus === "all" && age === "new24h" && successful === "any" && unsuccessful === "any" && method === "all" && activity === "all" && keysFilter === "all" && roleFilter === "all") return "new_today";
    if (paymentStatus === "pending" && successful === "any" && unsuccessful === "any" && method === "all" && age === "all" && activity === "all" && keysFilter === "all" && roleFilter === "all") return "pending";
    if (paymentStatus === "failed" && successful === "any" && unsuccessful === "any" && method === "all" && age === "all" && activity === "all" && keysFilter === "all" && roleFilter === "all") return "failed";
    if (paymentStatus === "all" && activity === "active" && successful === "any" && unsuccessful === "any" && method === "all" && age === "all" && keysFilter === "all" && roleFilter === "all") return "active_week";
    if (paymentStatus === "all" && keysFilter === "free_trial_used" && successful === "any" && unsuccessful === "any" && method === "all" && age === "all" && activity === "all" && roleFilter === "all") return "free_trial";
    return null;
  })();

  const applyChip = (chip: ChipKey) => {
    if (activeChip === chip) { resetFilters(); return; }
    resetFilters();
    if (chip === "paid") setPaymentStatus("paid");
    else if (chip === "new_today") setAge("new24h");
    else if (chip === "pending") setPaymentStatus("pending");
    else if (chip === "failed") setPaymentStatus("failed");
    else if (chip === "active_week") setActivity("active");
    else if (chip === "free_trial") setKeysFilter("free_trial_used");
  };


  const toggleExpand = (userId: string) => {
    setExpandedUser(expandedUser === userId ? null : userId);
    setNewKeyLabel("");
    setNewKeySecret("");
    setNewKeyHours("");
    setNewKeyMinutes("");
    setNewKeySeconds("");
    setEditingProfile(null);
    setNewPaymentUserId(null);
  };

  const getUserPayments = (userId: string) => payments.filter((p) => p.user_id === userId);
  const getUserKeys = (userId: string) => apiKeys.filter((k) => k.user_id === userId);
  const getUserRoles = (userId: string) => userRoles.filter((r) => r.user_id === userId);

  const createApiKey = async (userId: string) => {
    setCreatingKey(true);
    const totalMs = (parseFloat(newKeyHours) || 0) * 3600000 + (parseFloat(newKeyMinutes) || 0) * 60000 + (parseFloat(newKeySeconds) || 0) * 1000;
    // Routed through admin_issue_api_key rather than a raw insert: leaving
    // "Custom secret" blank used to fall through to api_keys.key's own
    // column default (a 64-char hex string) instead of the 11-char format
    // every other key on the platform uses — this RPC always generates a
    // real short key when no custom secret is supplied, and audit-logs the
    // grant since it bypasses payment entirely.
    const { error } = await supabase.rpc("admin_issue_api_key" as any, {
      p_user_id: userId,
      p_label: newKeyLabel || null,
      p_remaining_ms: totalMs > 0 ? totalMs : null,
      p_custom_key: newKeySecret.trim() || null,
    });
    if (error) {
      console.error("[internal]", error);
      toast({ title: "Error", description: getSafeErrorMessage(error.code), variant: "destructive" });
    } else {
      toast({ title: "Unique key created ✅" });
      setNewKeyLabel("");
      setNewKeySecret("");
      setNewKeyHours("");
      setNewKeyMinutes("");
      setNewKeySeconds("");
      onRefresh();
    }
    setCreatingKey(false);
  };

  const updateKeyExpirationCustom = async (id: string, totalMs: number) => {
    const updateData: any = {
      remaining_ms: totalMs > 0 ? totalMs : null,
      expires_at: null, // Reset expires_at; it will be set when user connects
      // Re-activate the key whenever admin grants time so previously expired
      // keys become usable again (Launch Studio button stops saying "Repurchase").
      is_active: totalMs > 0,
    };
    const { error } = await supabase.from("api_keys").update(updateData).eq("id", id);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      toast({ title: totalMs > 0 ? "Timer set ⏱️ key reactivated" : "Timer removed" });
      setCustomHours(""); setCustomMinutes(""); setCustomSeconds("");
      onRefresh();
    }
  };

  const formatMs = (ms: number) => {
    if (ms <= 0) return "Expired";
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    if (h > 24) return `${Math.floor(h / 24)}d ${h % 24}h ${m}m`;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  const getTimeRemaining = (key: any) => {
    // If connected (has expires_at), show live countdown
    if (key.expires_at) {
      const diff = new Date(key.expires_at).getTime() - Date.now();
      if (diff <= 0) return "Expired";
      return formatMs(diff) + " (active)";
    }
    // If disconnected, show paused remaining_ms
    if (key.remaining_ms != null && key.remaining_ms > 0) {
      return formatMs(key.remaining_ms) + " (paused)";
    }
    if (key.remaining_ms != null && key.remaining_ms <= 0) {
      return "Expired";
    }
    return null;
  };

  const toggleApiKey = async (id: string, isActive: boolean) => {
    const { error } = await supabase.from("api_keys").update({ is_active: !isActive }).eq("id", id);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      toast({ title: isActive ? "Key deactivated" : "Key activated" });
      onRefresh();
    }
  };

  const deleteApiKey = async (id: string) => {
    const { error } = await supabase.from("api_keys").delete().eq("id", id);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Key deleted 🗑️" });
      onRefresh();
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
      onRefresh();
    }
  };


  const updatePaymentStatus = async (id: string, status: "confirmed" | "rejected") => {
    const pay = payments.find((p) => p.id === id);
    const { error } = await supabase.rpc("admin_set_payment_status" as any, {
      p_payment_id: id,
      p_status: status,
      p_plan_id: null,
      p_amount_usd: status === "confirmed" ? pay?.amount_usd ?? null : null,
    });
    if (error) {
      console.error("[UserManager.updatePaymentStatus]", error);
      toast({
        title: "Error",
        description: `${getSafeErrorMessage(error.code)} — ${error.message}`,
        variant: "destructive",
      });
    } else {
      toast({ title: `Payment ${status}! ✅` });
      // Fire-and-forget admin alert.
      const owner = pay ? profiles.find((pr) => pr.user_id === pay.user_id) : undefined;
      notifyAdminPaymentEvent({
        paymentId: id,
        eventType: status === "confirmed" ? "admin_confirmed" : "admin_rejected",
        userEmail: owner?.email ?? null,
        userDisplayName: owner?.display_name ?? null,
        amountUsd: pay?.amount_usd ?? null,
        currency: pay?.currency ?? null,
        paymentMethod: (pay as any)?.payment_method ?? null,
        reference: pay?.tx_hash ?? null,
      });
      onRefresh();
    }
  };

  const deletePayment = async (id: string) => {
    const { error } = await supabase.from("payments").delete().eq("id", id);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Payment deleted 🗑️" });
      onRefresh();
    }
  };

  const createPaymentForUser = async (userId: string) => {
    const amt = newPaymentAmount ? parseFloat(newPaymentAmount) : null;
    let matchedPlanId: string | null = null;
    if (amt != null) {
      const { data: plan } = await supabase
        .from("pricing_plans")
        .select("id")
        .eq("is_active", true)
        .eq("price_usd", amt)
        .order("sort_order")
        .limit(1)
        .maybeSingle();
      matchedPlanId = (plan as any)?.id ?? null;
    }
    const { error } = await supabase.from("payments").insert({
      user_id: userId,
      currency: newPaymentCurrency,
      payment_method: "crypto",
      tx_hash: newPaymentTxHash.trim() || null,
      amount_usd: amt,
      plan_id: matchedPlanId,
      status: newPaymentStatus,
    });
    if (error) {
      console.error("[UserManager.createPaymentForUser]", error);
      toast({
        title: "Error",
        description: `${getSafeErrorMessage(error.code)} — ${error.message}`,
        variant: "destructive",
      });
    } else {
      toast({ title: "Payment created ✅" });
      setNewPaymentTxHash("");
      setNewPaymentAmount("");
      setNewPaymentUserId(null);
      onRefresh();
    }
  };

  const assignRole = async (userId: string, role: "admin" | "sec_admin" | "moderator" | "user") => {
    const existing = getUserRoles(userId).find((r) => r.role === role);
    if (existing) {
      toast({ title: "Role already assigned" });
      return;
    }
    const { error } = await supabase.from("user_roles").insert({ user_id: userId, role });
    if (error) {
      console.error("[internal]", error);
      toast({ title: "Error", description: getSafeErrorMessage(error.code), variant: "destructive" });
    } else {
      toast({ title: `Role '${role}' assigned ✅` });
      onRefresh();
    }
  };

  const removeRole = async (roleId: string) => {
    const { error } = await supabase.from("user_roles").delete().eq("id", roleId);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Role removed" });
      onRefresh();
    }
  };

  const startEditProfile = (p: Profile) => {
    setEditingProfile(p.user_id);
    setEditDisplayName(p.display_name ?? "");
    setEditEmail(p.email ?? "");
  };

  const saveProfile = async (userId: string) => {
    const { error } = await supabase.from("profiles").update({
      display_name: editDisplayName || null,
      email: editEmail || null,
    }).eq("user_id", userId);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Profile updated ✅" });
      setEditingProfile(null);
      onRefresh();
    }
  };

  const deleteProfile = async (userId: string) => {
    if (!confirm("Are you sure you want to delete this user's profile? This cannot be undone.")) return;
    const { error } = await supabase.from("profiles").delete().eq("user_id", userId);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Profile deleted 🗑️" });
      onRefresh();
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-heading font-bold text-foreground">Manage Users</h2>
        <span className="text-xs text-muted-foreground font-heading">{filtered.length} users</span>
      </div>

      <Input
        placeholder="Search by email, name, or user ID..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="bg-muted/30 border-border max-w-md"
      />

      {/* Quick filter chips */}
      <div className="flex flex-wrap gap-2">
        {[
          { key: "paid" as const, label: "💰 Paid users" },
          { key: "new_today" as const, label: "🆕 New today" },
          { key: "pending" as const, label: "⏳ Pending payments" },
          { key: "failed" as const, label: "❌ Failed payments" },
          { key: "active_week" as const, label: "🔥 Active this week" },
          { key: "free_trial" as const, label: "🎁 Used free trial" },
        ].map((c) => (
          <button
            key={c.key}
            onClick={() => applyChip(c.key)}
            className={`text-xs font-heading px-3 py-1.5 rounded-full border transition-all ${
              activeChip === c.key
                ? "bg-primary/20 text-primary border-primary/50 neon-border"
                : "bg-muted/20 text-muted-foreground border-border hover:bg-muted/40"
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      {/* Filter dropdowns */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Select value={paymentStatus} onValueChange={(v) => setPaymentStatus(v as PaymentStatusFilter)}>
          <SelectTrigger className="h-9 text-xs bg-muted/30"><SelectValue placeholder="Payment status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Payment: All</SelectItem>
            <SelectItem value="paid">Paid (≥1 confirmed)</SelectItem>
            <SelectItem value="pending">Pending only</SelectItem>
            <SelectItem value="failed">Failed only</SelectItem>
            <SelectItem value="attempted">Attempted (any)</SelectItem>
            <SelectItem value="never">Never attempted</SelectItem>
          </SelectContent>
        </Select>

        <Select value={successful} onValueChange={(v) => setSuccessful(v as SuccessfulFilter)}>
          <SelectTrigger className="h-9 text-xs bg-muted/30"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Successful: Any</SelectItem>
            <SelectItem value="0">0 successful</SelectItem>
            <SelectItem value="1">1 successful</SelectItem>
            <SelectItem value="2plus">2+ successful</SelectItem>
          </SelectContent>
        </Select>

        <div className="flex items-center gap-1">
          <Select value={unsuccessful} onValueChange={(v) => setUnsuccessful(v as UnsuccessfulFilter)}>
            <SelectTrigger className="h-9 text-xs bg-muted/30"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Unsuccessful: Any</SelectItem>
              <SelectItem value="rejected">Has rejected</SelectItem>
              <SelectItem value="stale_review">Stuck in review &gt;{staleHours}h</SelectItem>
              <SelectItem value="none">None unsuccessful</SelectItem>
            </SelectContent>
          </Select>
          <Input
            type="number"
            min={1}
            max={720}
            step={1}
            value={staleHours}
            onChange={(e) => {
              const n = Math.min(720, Math.max(1, Math.floor(Number(e.target.value) || 24)));
              setStaleHours(n);
              try { localStorage.setItem("admin-stale-review-hours", String(n)); } catch { /* ignore */ }
            }}
            title="Stale after (hrs)"
            aria-label="Stale review threshold in hours"
            className="h-9 w-16 text-xs bg-muted/30 px-2"
          />
        </div>

        <Select value={method} onValueChange={(v) => setMethod(v as MethodFilter)}>
          <SelectTrigger className="h-9 text-xs bg-muted/30"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Method: All</SelectItem>
            <SelectItem value="crypto">Crypto only</SelectItem>
            <SelectItem value="none">None</SelectItem>
          </SelectContent>
        </Select>

        <Select value={age} onValueChange={(v) => setAge(v as AgeFilter)}>
          <SelectTrigger className="h-9 text-xs bg-muted/30"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Age: All</SelectItem>
            <SelectItem value="new24h">New (&lt;24h)</SelectItem>
            <SelectItem value="week">This week</SelectItem>
            <SelectItem value="month">This month</SelectItem>
            <SelectItem value="older30">Older than 30d</SelectItem>
            <SelectItem value="older90">Older than 90d</SelectItem>
          </SelectContent>
        </Select>

        <Select value={activity} onValueChange={(v) => setActivity(v as ActivityFilter)}>
          <SelectTrigger className="h-9 text-xs bg-muted/30"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Activity: All</SelectItem>
            <SelectItem value="active">Active (&lt;7d)</SelectItem>
            <SelectItem value="idle">Idle (7-30d)</SelectItem>
            <SelectItem value="dormant">Dormant (&gt;30d)</SelectItem>
          </SelectContent>
        </Select>

        <Select value={keysFilter} onValueChange={(v) => setKeysFilter(v as KeysFilter)}>
          <SelectTrigger className="h-9 text-xs bg-muted/30"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Unique Keys: All</SelectItem>
            <SelectItem value="active_key">Has active key</SelectItem>
            <SelectItem value="no_active_key">No active key</SelectItem>
            <SelectItem value="expired_key">Has expired key</SelectItem>
            <SelectItem value="free_trial_used">Free trial used</SelectItem>
          </SelectContent>
        </Select>

        <Select value={roleFilter} onValueChange={(v) => setRoleFilter(v as RoleFilter)}>
          <SelectTrigger className="h-9 text-xs bg-muted/30"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Role: All</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
            <SelectItem value="moderator">Moderator</SelectItem>
            <SelectItem value="user_only">User only</SelectItem>
          </SelectContent>
        </Select>

        <Select value={termsFilter} onValueChange={(v) => setTermsFilter(v as TermsFilter)}>
          <SelectTrigger className="h-9 text-xs bg-muted/30"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Terms: All</SelectItem>
            <SelectItem value="accepted">Accepted current</SelectItem>
            <SelectItem value="pending">Pending / outdated</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Sort + summary strip */}
      <div className="flex flex-wrap items-center gap-3 justify-between glass rounded-xl px-4 py-2.5">
        <div className="text-xs text-muted-foreground font-heading">
          Showing <span className="text-foreground font-semibold">{filtered.length}</span> of {profiles.length} users
          <span className="mx-2">·</span>
          <span className="text-primary font-semibold">{filteredPaidCount} paid</span>
          <span className="mx-2">·</span>
          <span className="text-foreground font-semibold">${filteredRevenue.toFixed(2)}</span> revenue
          <span className="text-muted-foreground/60"> / ${totalRevenue.toFixed(2)} total</span>
        </div>
        <div className="flex items-center gap-2">
          <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
            <SelectTrigger className="h-8 text-xs bg-muted/30 w-[160px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest first</SelectItem>
              <SelectItem value="oldest">Oldest first</SelectItem>
              <SelectItem value="most_paid">Most paid (USD)</SelectItem>
              <SelectItem value="most_payments">Most payments</SelectItem>
              <SelectItem value="most_active">Most active</SelectItem>
              <SelectItem value="email_asc">Email A-Z</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" onClick={resetFilters} className="h-8 font-heading text-xs">
            Reset
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        {filtered.map((p) => {
          const isExpanded = expandedUser === p.user_id;
          const uPayments = getUserPayments(p.user_id);
          const uKeys = getUserKeys(p.user_id);
          const uRoles = getUserRoles(p.user_id);
          const hasPaid = uPayments.some((pay) => pay.status === "confirmed");

          return (
            <div key={p.user_id} className="glass rounded-xl overflow-hidden">
              <button
                onClick={() => toggleExpand(p.user_id)}
                className="w-full px-4 py-3 flex items-center justify-between flex-wrap gap-y-2 text-sm hover:bg-muted/20 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-heading font-bold text-xs">
                    {(p.email ?? "?")[0].toUpperCase()}
                  </div>
                  <div className="text-left">
                    <div className="font-heading font-semibold text-foreground">{p.display_name || p.email || "No email"}</div>
                    {p.display_name && p.email && (
                      <div className="text-xs text-muted-foreground">{p.email}</div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {uRoles.map((r) => (
                    <span key={r.id} className="text-xs bg-accent/20 text-accent px-2 py-0.5 rounded-full font-heading">
                      {r.role}
                    </span>
                  ))}
                  {hasPaid && <span className="text-xs bg-primary/20 text-primary px-2 py-0.5 rounded-full font-heading">Paid</span>}
                  {p.terms_accepted_at && p.terms_version === TERMS_VERSION ? (
                    <span
                      className="text-xs bg-emerald-500/15 text-emerald-400 px-2 py-0.5 rounded-full font-heading"
                      title={`Terms ${p.terms_version} accepted ${new Date(p.terms_accepted_at).toLocaleString()}`}
                    >
                      ✓ Terms
                    </span>
                  ) : (
                    <span
                      className="text-xs bg-amber-500/15 text-amber-400 px-2 py-0.5 rounded-full font-heading"
                      title={p.terms_accepted_at ? `Accepted old version: ${p.terms_version}` : "Has not accepted terms"}
                    >
                      ⚠ Terms pending
                    </span>
                  )}
                  <span className="text-xs bg-muted/50 text-muted-foreground px-2 py-0.5 rounded-full font-heading">{uKeys.length} keys</span>
                  <span className="text-xs bg-muted/50 text-muted-foreground px-2 py-0.5 rounded-full font-heading">{uPayments.length} payments</span>
                  <span
                    role="button"
                    onClick={(e) => { e.stopPropagation(); setDetailUserId(p.user_id); }}
                    className="text-xs bg-primary/10 text-primary hover:bg-primary/20 px-2 py-0.5 rounded-full font-heading cursor-pointer"
                  >
                    Details
                  </span>
                  <span
                    role="button"
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (!confirm(`Schedule deletion of ${p.email ?? p.user_id}?\n\nThe user will be signed out and all their data will be permanently wiped from our servers in 7 days. You can cancel from the Deletions tab before then.`)) return;
                      const { data, error } = await supabase.functions.invoke("request-account-deletion", {
                        body: { target_user_id: p.user_id, notes: "Deleted by admin from Users tab" },
                      });
                      if (error || (data as any)?.code) {
                        toast({ title: "Error", description: (data as any)?.message ?? error?.message, variant: "destructive" });
                      } else {
                        toast({ title: "Account scheduled for deletion 🗑️", description: "Wipes in 7 days. Manage in Deletions tab." });
                        onRefresh();
                      }
                    }}
                    className="text-xs bg-destructive/10 text-destructive hover:bg-destructive/20 px-2 py-0.5 rounded-full font-heading cursor-pointer"
                  >
                    Delete
                  </span>
                  <span className="text-xs text-muted-foreground">{isExpanded ? "▲" : "▼"}</span>
                </div>
              </button>

              {isExpanded && (
                <div className="border-t border-border px-4 py-4 space-y-4">
                  {/* User info / Edit profile */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-heading text-muted-foreground uppercase tracking-wider">Profile</h4>
                      {isAdmin && (
                        <div className="flex gap-2">
                          {editingProfile !== p.user_id ? (
                            <Button size="sm" variant="outline" onClick={() => startEditProfile(p)} className="font-heading text-xs h-6 px-2">Edit</Button>
                          ) : (
                            <>
                              <Button size="sm" onClick={() => saveProfile(p.user_id)} className="font-heading text-xs h-6 px-2">Save</Button>
                              <Button size="sm" variant="outline" onClick={() => setEditingProfile(null)} className="font-heading text-xs h-6 px-2">Cancel</Button>
                            </>
                          )}
                          <Button size="sm" variant="outline" onClick={() => deleteProfile(p.user_id)} className="border-destructive/30 text-destructive hover:bg-destructive/10 font-heading text-xs h-6 px-2">Delete User</Button>
                        </div>
                      )}
                    </div>
                    {editingProfile === p.user_id ? (
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                        <div>
                          <span className="text-muted-foreground font-heading">User ID</span>
                          <div className="font-mono text-foreground/80 mt-0.5 truncate">{p.user_id}</div>
                        </div>
                        <div>
                          <span className="text-muted-foreground font-heading">Email</span>
                          <Input value={editEmail} onChange={(e) => setEditEmail(e.target.value)} className="h-7 text-xs mt-0.5" />
                        </div>
                        <div>
                          <span className="text-muted-foreground font-heading">Display Name</span>
                          <Input value={editDisplayName} onChange={(e) => setEditDisplayName(e.target.value)} className="h-7 text-xs mt-0.5" />
                        </div>
                        <div>
                          <span className="text-muted-foreground font-heading">Joined</span>
                          <div className="text-foreground/80 mt-0.5">{new Date(p.created_at).toLocaleDateString()}</div>
                        </div>
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                        <div>
                          <span className="text-muted-foreground font-heading">User ID</span>
                          <div className="font-mono text-foreground/80 mt-0.5 truncate">{p.user_id}</div>
                        </div>
                        <div>
                          <span className="text-muted-foreground font-heading">Email</span>
                          <div className="text-foreground/80 mt-0.5">{p.email ?? "N/A"}</div>
                        </div>
                        <div>
                          <span className="text-muted-foreground font-heading">Display Name</span>
                          <div className="text-foreground/80 mt-0.5">{p.display_name ?? "N/A"}</div>
                        </div>
                        <div>
                          <span className="text-muted-foreground font-heading">Joined</span>
                          <div className="text-foreground/80 mt-0.5">{new Date(p.created_at).toLocaleDateString()}</div>
                        </div>
                      </div>
                    )}
                  </div>

                  {isAdmin && (
                    <>
                      {/* Roles Management */}
                      <div className="space-y-2">
                        <h4 className="text-xs font-heading text-muted-foreground uppercase tracking-wider">Roles</h4>
                        <div className="flex items-center gap-2 flex-wrap">
                          {uRoles.map((r) => (
                            <span key={r.id} className="inline-flex items-center gap-1 text-xs bg-accent/20 text-accent px-2 py-1 rounded-full font-heading">
                              {r.role}
                              <button onClick={() => removeRole(r.id)} className="hover:text-destructive ml-1">✕</button>
                            </span>
                          ))}
                          {(["admin", "sec_admin", "moderator", "user"] as const)
                            .filter((role) => !uRoles.some((r) => r.role === role))
                            .map((role) => (
                              <Button key={role} size="sm" variant="outline" onClick={() => assignRole(p.user_id, role)} className="font-heading text-xs h-7">
                                + {role}
                              </Button>
                            ))}
                        </div>
                      </div>

                      {/* Partner attribution */}
                      <div className="space-y-2">
                        <h4 className="text-xs font-heading text-muted-foreground uppercase tracking-wider">Partner Attribution</h4>
                        <div className="flex items-center gap-2 flex-wrap">
                          <select
                            value={partnerSelections[p.user_id] ?? attributions[p.user_id] ?? "__none__"}
                            onChange={(e) => setPartnerSelections({ ...partnerSelections, [p.user_id]: e.target.value })}
                            className="bg-muted/30 border border-border rounded-lg px-2 py-1 text-xs font-heading text-foreground h-8 min-w-[200px]"
                          >
                            <option value="__none__">— No partner —</option>
                            {partnersList.map((pt) => (
                              <option key={pt.id} value={pt.id}>
                                {pt.code}{pt.display_name ? ` · ${pt.display_name}` : ""}
                              </option>
                            ))}
                          </select>
                          <Button
                            size="sm"
                            onClick={() => setUserPartner(p.user_id)}
                            disabled={savingPartnerFor === p.user_id}
                            className="font-heading text-xs h-8"
                          >
                            {savingPartnerFor === p.user_id ? "Saving..." : "Save"}
                          </Button>
                          {attributions[p.user_id] && (
                            <span className="text-[10px] text-muted-foreground font-heading">
                              Currently: {partnersList.find((x) => x.id === attributions[p.user_id])?.code ?? "unknown"}
                            </span>
                          )}
                        </div>
                      </div>
                    </>
                  )}

                  {canManagePayments && (<>
                  {/* Payments */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-heading text-muted-foreground uppercase tracking-wider">Payments ({uPayments.length})</h4>
                      <Button size="sm" variant="outline" onClick={() => setNewPaymentUserId(newPaymentUserId === p.user_id ? null : p.user_id)} className="font-heading text-xs h-6 px-2">
                        + Add Payment
                      </Button>
                    </div>

                    {newPaymentUserId === p.user_id && (
                      <div className="bg-muted/20 rounded-lg p-3 space-y-2">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                          <div>
                            <span className="text-xs text-muted-foreground font-heading">Currency</span>
                            <select
                              value={newPaymentCurrency}
                              onChange={(e) => setNewPaymentCurrency(e.target.value as "BTC" | "BNB" | "USDT-BEP20" | "USDT-TRC20")}
                              className="w-full bg-muted/30 border border-border rounded-lg px-2 py-1 text-xs font-heading text-foreground mt-0.5"
                            >
                              <option value="BTC">BTC</option>
                              <option value="BNB">BNB</option>
                              <option value="USDT-BEP20">USDT (BEP-20)</option>
                              <option value="USDT-TRC20">USDT (TRC20)</option>
                            </select>
                          </div>
                          <div>
                            <span className="text-xs text-muted-foreground font-heading">Amount (USD)</span>
                            <Input value={newPaymentAmount} onChange={(e) => setNewPaymentAmount(e.target.value)} type="number" className="h-7 text-xs mt-0.5" placeholder="0.00" />
                          </div>
                          <div>
                            <span className="text-xs text-muted-foreground font-heading">TX Hash</span>
                            <Input value={newPaymentTxHash} onChange={(e) => setNewPaymentTxHash(e.target.value)} className="h-7 text-xs mt-0.5" placeholder="Optional" />
                          </div>
                          <div>
                            <span className="text-xs text-muted-foreground font-heading">Status</span>
                            <select
                              value={newPaymentStatus}
                              onChange={(e) => setNewPaymentStatus(e.target.value as "pending" | "confirmed" | "rejected")}
                              className="w-full bg-muted/30 border border-border rounded-lg px-2 py-1 text-xs font-heading text-foreground mt-0.5"
                            >
                              <option value="confirmed">Confirmed</option>
                              <option value="pending">Pending</option>
                              <option value="rejected">Rejected</option>
                            </select>
                          </div>
                        </div>
                        <Button size="sm" onClick={() => createPaymentForUser(p.user_id)} className="font-heading text-xs h-7">Create Payment</Button>
                      </div>
                    )}

                    {uPayments.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No payments</p>
                    ) : (
                      <div className="space-y-1">
                        {uPayments.map((pay) => (
                          <div key={pay.id} className="flex items-center justify-between bg-muted/20 rounded-lg px-3 py-2 text-xs">
                            <div className="flex items-center gap-2">
                              <span className="font-heading font-semibold">{pay.currency}</span>
                              {pay.amount_usd != null && <span className="text-muted-foreground">${pay.amount_usd}</span>}
                              <span className="font-mono text-foreground/70 truncate max-w-[180px]">{pay.tx_hash}</span>
                              <span className="text-muted-foreground">{new Date(pay.created_at).toLocaleDateString()}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className={`font-heading font-semibold px-2 py-0.5 rounded-full ${
                                pay.status === "confirmed" ? "bg-primary/20 text-primary" :
                                pay.status === "rejected" ? "bg-destructive/20 text-destructive" :
                                "bg-amber-500/20 text-amber-400"
                              }`}>{pay.status}</span>
                              {pay.status === "pending" && (
                                <div className="flex gap-1">
                                  <Button size="sm" onClick={() => updatePaymentStatus(pay.id, "confirmed")} className="font-heading text-xs h-6 px-2">✓</Button>
                                  <Button size="sm" variant="outline" onClick={() => updatePaymentStatus(pay.id, "rejected")} className="border-destructive/30 text-destructive font-heading text-xs h-6 px-2">✕</Button>
                                </div>
                              )}
                              <Button size="sm" variant="outline" onClick={() => deletePayment(pay.id)} className="border-destructive/30 text-destructive hover:bg-destructive/10 font-heading text-xs h-6 px-2">🗑️</Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  </>)}

                  {isAdmin && (<>
                  {/* Unique Keys */}
                  <div className="space-y-2">
                    <h4 className="text-xs font-heading text-muted-foreground uppercase tracking-wider">Unique Keys ({uKeys.length})</h4>
                    {uKeys.map((k) => {
                      const timerDisplay = getTimeRemaining(k);
                      const isExpired = timerDisplay === "Expired";
                      return (
                        <div key={k.id} className="bg-muted/20 rounded-lg px-3 py-2 text-xs space-y-1">
                          <div className="flex items-center gap-3 flex-wrap gap-y-1">
                            <div className="flex-1 min-w-0">
                              <span className="text-muted-foreground font-heading">{k.label ?? "Unlabeled"}</span>
                              <div className="font-mono text-foreground/70 truncate mt-0.5">{k.key}</div>
                            </div>
                            <span className={`font-heading font-semibold px-2 py-0.5 rounded-full ${k.is_active ? "bg-primary/20 text-primary" : "bg-destructive/20 text-destructive"}`}>
                              {k.is_active ? "Active" : "Inactive"}
                            </span>
                            {timerDisplay && (
                              <span className={`font-heading text-xs px-2 py-0.5 rounded-full ${
                                isExpired ? "bg-destructive/20 text-destructive" : timerDisplay.includes("paused") ? "bg-muted/50 text-muted-foreground" : "bg-amber-500/20 text-amber-400"
                              }`}>
                                ⏱️ {timerDisplay}
                              </span>
                            )}
                            <Button size="sm" variant="outline" onClick={() => openEditKey(k)} className="font-heading text-xs h-6 px-2">
                              Edit
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => toggleApiKey(k.id, k.is_active)} className="font-heading text-xs h-6 px-2">
                              {k.is_active ? "Disable" : "Enable"}
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => deleteApiKey(k.id)} className="border-destructive/30 text-destructive font-heading text-xs h-6 px-2">
                              Delete
                            </Button>
                          </div>
                          {/* Timer controls - custom input */}
                          <div className="flex items-center gap-1.5 pt-1 border-t border-border/30 flex-wrap">
                            <span className="text-muted-foreground font-heading text-[10px]">Set timer:</span>
                            <Input
                              placeholder="H"
                              value={customHours}
                              onChange={(e) => setCustomHours(e.target.value)}
                              type="number" min="0"
                              className="bg-muted/30 border-border text-[10px] h-6 w-12 px-1"
                            />
                            <span className="text-muted-foreground text-[10px]">h</span>
                            <Input
                              placeholder="M"
                              value={customMinutes}
                              onChange={(e) => setCustomMinutes(e.target.value)}
                              type="number" min="0" max="59"
                              className="bg-muted/30 border-border text-[10px] h-6 w-12 px-1"
                            />
                            <span className="text-muted-foreground text-[10px]">m</span>
                            <Input
                              placeholder="S"
                              value={customSeconds}
                              onChange={(e) => setCustomSeconds(e.target.value)}
                              type="number" min="0" max="59"
                              className="bg-muted/30 border-border text-[10px] h-6 w-12 px-1"
                            />
                            <span className="text-muted-foreground text-[10px]">s</span>
                            <button
                              onClick={() => {
                                const ms = (parseFloat(customHours) || 0) * 3600000 + (parseFloat(customMinutes) || 0) * 60000 + (parseFloat(customSeconds) || 0) * 1000;
                                if (ms > 0) updateKeyExpirationCustom(k.id, ms);
                              }}
                              className="text-[10px] px-2 py-0.5 rounded bg-primary/20 hover:bg-primary/30 text-primary transition-colors font-heading"
                            >
                              Apply
                            </button>
                            {/* Quick presets */}
                            {[{l:"1h",ms:3600000},{l:"24h",ms:86400000},{l:"7d",ms:604800000},{l:"30d",ms:2592000000}].map((p) => (
                              <button
                                key={p.l}
                                onClick={() => updateKeyExpirationCustom(k.id, p.ms)}
                                className="text-[10px] px-1.5 py-0.5 rounded bg-muted/40 hover:bg-primary/20 text-muted-foreground hover:text-primary transition-colors font-heading"
                              >
                                {p.l}
                              </button>
                            ))}
                            {(k.expires_at || (k as any).remaining_ms) && (
                              <button
                                onClick={() => updateKeyExpirationCustom(k.id, 0)}
                                className="text-[10px] px-1.5 py-0.5 rounded bg-destructive/10 hover:bg-destructive/20 text-destructive transition-colors font-heading"
                              >
                                Remove
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}

                    <div className="flex gap-2 items-center flex-wrap">
                      <Input
                        placeholder="Key label (optional)"
                        value={newKeyLabel}
                        onChange={(e) => setNewKeyLabel(e.target.value)}
                        className="bg-muted/30 border-border text-xs h-8 max-w-[180px]"
                      />
                      <Input
                        placeholder="Custom code (blank = auto-generate)"
                        value={newKeySecret}
                        onChange={(e) => setNewKeySecret(e.target.value)}
                        className="bg-muted/30 border-border text-xs h-8 max-w-[240px] font-mono"
                      />
                      <div className="flex gap-1 items-center">
                        <Input
                          placeholder="H"
                          value={newKeyHours}
                          onChange={(e) => setNewKeyHours(e.target.value)}
                          type="number" min="0"
                          className="bg-muted/30 border-border text-xs h-8 w-14 px-1"
                        />
                        <span className="text-muted-foreground text-[10px]">h</span>
                        <Input
                          placeholder="M"
                          value={newKeyMinutes}
                          onChange={(e) => setNewKeyMinutes(e.target.value)}
                          type="number" min="0" max="59"
                          className="bg-muted/30 border-border text-xs h-8 w-14 px-1"
                        />
                        <span className="text-muted-foreground text-[10px]">m</span>
                        <Input
                          placeholder="S"
                          value={newKeySeconds}
                          onChange={(e) => setNewKeySeconds(e.target.value)}
                          type="number" min="0" max="59"
                          className="bg-muted/30 border-border text-xs h-8 w-14 px-1"
                        />
                        <span className="text-muted-foreground text-[10px]">s</span>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => createApiKey(p.user_id)}
                        disabled={creatingKey}
                        className="font-heading text-xs h-8"
                      >
                        + Create Key
                      </Button>
                    </div>
                  </div>
                  </>)}
                </div>
              )}
            </div>
          );
        })}
        {filtered.length === 0 && <p className="text-sm text-muted-foreground">No users found.</p>}
      </div>

      <Dialog open={!!editingKey} onOpenChange={(o) => !o && setEditingKey(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-heading">Edit Unique Key</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="um-edit-key-label" className="font-heading text-xs">Label</Label>
              <Input id="um-edit-key-label" value={editKeyLabel} onChange={(e) => setEditKeyLabel(e.target.value)} placeholder="Default" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="um-edit-key-value" className="font-heading text-xs">Key</Label>
              <Input id="um-edit-key-value" value={editKeyValue} onChange={(e) => setEditKeyValue(e.target.value)} className="font-mono text-xs" />
              <p className="text-xs text-muted-foreground">Changing the key value invalidates the previous one for the user.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingKey(null)} className="font-heading">Cancel</Button>
            <Button onClick={saveEditKey} disabled={savingEdit} className="font-heading">{savingEdit ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <UserDetailDrawer userId={detailUserId} onClose={() => setDetailUserId(null)} />
    </div>
  );
}
