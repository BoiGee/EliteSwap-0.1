import { useCallback, useEffect, useState } from "react";
import { useAuth } from "./useAuth";
import { fromTable, rpc, type Storefront } from "@/lib/reseller";

export interface ResellerAccount {
  id: string;
  code: string;
  display_name: string;
  is_active: boolean;
}

/** The signed-in user's own reseller account, if they are one. */
export function useResellerAccount() {
  const { user } = useAuth();
  const [account, setAccount] = useState<ResellerAccount | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!user) { setAccount(null); setLoading(false); return; }
    setLoading(true);
    fromTable("resellers")
      .select("id, code, display_name, is_active")
      .eq("user_id", user.id)
      .maybeSingle()
      .then(({ data }: { data: unknown }) => {
        if (cancelled) return;
        setAccount((data as unknown as ResellerAccount) ?? null);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [user]);

  return { account, loading };
}

/**
 * The reseller the signed-in customer buys through (only while that reseller is active).
 * While this is set, Elite Swap's own plan checkout is hidden and refused server-side.
 */
export function useMyReseller() {
  const { user } = useAuth();
  const [reseller, setReseller] = useState<Storefront | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!user) { setReseller(null); setLoading(false); return; }
    const { data, error } = await rpc("my_reseller");
    setReseller(error ? null : ((data as unknown as Storefront) ?? null));
    setLoading(false);
  }, [user]);

  useEffect(() => { refresh(); }, [refresh]);

  return { reseller, loading, refresh };
}
