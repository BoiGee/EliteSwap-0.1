import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { isDevAdminOverrideEnabled } from "@/lib/devAdmin";
import { useAuth } from "./useAuth";

export function useAdmin() {
  const { user } = useAuth();
  const [isAdmin, setIsAdmin] = useState(false);
  const [isModerator, setIsModerator] = useState(false);
  const [isSecAdmin, setIsSecAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) {
      setIsAdmin(false);
      setIsModerator(false);
      setIsSecAdmin(false);
      setLoading(false);
      return;
    }

    if (isDevAdminOverrideEnabled(window.location.search)) {
      setIsAdmin(true);
      setIsModerator(false);
      setIsSecAdmin(false);
      setLoading(false);
      return;
    }

    const checkRoles = async () => {
      const { data } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id);
      const roles = (data ?? []).map((r: any) => r.role);
      setIsAdmin(roles.includes("admin"));
      setIsModerator(roles.includes("moderator"));
      setIsSecAdmin(roles.includes("sec_admin"));
      setLoading(false);
    };

    checkRoles();
  }, [user]);

  const isStaff = isAdmin || isModerator || isSecAdmin;
  const canManagePayments = isAdmin || isSecAdmin;
  const canManageDiscounts = isAdmin || isSecAdmin;
  return { isAdmin, isModerator, isSecAdmin, isStaff, canManagePayments, canManageDiscounts, loading };
}
