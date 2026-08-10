import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface SystemAnnouncement {
  id: string;
  title: string;
  message: string;
  severity: "info" | "warning" | "critical";
  display_banner: boolean;
  display_modal: boolean;
  cta_label: string | null;
  cta_url: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export function useActiveAnnouncement() {
  const [announcement, setAnnouncement] = useState<SystemAnnouncement | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const fetchActive = async () => {
      const { data } = await supabase
        .from("system_announcements")
        .select("*")
        .eq("is_active", true)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!cancelled) {
        setAnnouncement((data as SystemAnnouncement | null) ?? null);
        setLoading(false);
      }
    };

    fetchActive();

    // Poll periodically instead of subscribing via realtime so draft/inactive
    // announcements can never leak over the realtime broadcast stream.
    const interval = setInterval(fetchActive, 30000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return { announcement, loading };
}
