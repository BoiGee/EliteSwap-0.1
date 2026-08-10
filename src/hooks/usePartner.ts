import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";

export interface PartnerRow {
  id: string;
  user_id: string;
  code: string;
  display_name: string | null;
  commission_pct: number;
  is_active: boolean;
}

export interface PartnerStats {
  referred_users: number;
  confirmed_payments: number;
  gross_earnings_usd: number;
  paid_out_usd: number;
  balance_owed_usd: number;
  commission_pct: number;
}

export function usePartner() {
  const { user } = useAuth();
  const [partner, setPartner] = useState<PartnerRow | null>(null);
  const [stats, setStats] = useState<PartnerStats | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!user) {
      setPartner(null);
      setStats(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data: p } = await supabase
      .from("partners" as any)
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();
    if (p) {
      setPartner(p as any);
      const { data: s } = await supabase.rpc("partner_stats" as any, {
        p_partner_id: (p as any).id,
      });
      if (Array.isArray(s) && s.length > 0) setStats(s[0] as any);
    } else {
      setPartner(null);
      setStats(null);
    }
    setLoading(false);
  }, [user]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { partner, stats, loading, refresh };
}
