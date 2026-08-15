-- Full-repo audit (2026-08-15): 20260812160000 found 15 SECURITY DEFINER
-- functions still granted EXECUTE to PUBLIC (the Postgres default for any
-- newly created function unless explicitly revoked) via a single one-off
-- manual audit — of the ~139 SECURITY DEFINER functions in this schema,
-- only ~10 had an explicit REVOKE at the time. Rather than relying on
-- catching the next one by accident, this is a read-only admin RPC that
-- re-runs that same check on demand, so it can be wired into a periodic
-- admin-panel glance instead of a one-time audit.
CREATE OR REPLACE FUNCTION public.admin_list_functions_missing_execute_revoke()
RETURNS TABLE(function_name text, arg_types text, has_public_execute boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  RETURN QUERY
  SELECT
    p.proname::text,
    pg_get_function_identity_arguments(p.oid),
    has_function_privilege('public', p.oid, 'EXECUTE')
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosecdef = true
    AND has_function_privilege('public', p.oid, 'EXECUTE')
  ORDER BY 1;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_functions_missing_execute_revoke() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_list_functions_missing_execute_revoke() TO authenticated;
