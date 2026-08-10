-- Paid Users tab audit found two real bugs, both verified against live data
-- before writing this fix:
--
-- 1. PaidUsersManager.tsx queried studio_sessions with no pagination —
--    the table has 5,575 rows (verified), so PostgREST's default 1000-row
--    cap silently limited every "Studio time" total to ~18% of real usage,
--    for every user, with no ordering so the sample wasn't even
--    consistently biased toward old or new sessions. Fixed by aggregating
--    server-side (GROUP BY) instead of pulling raw rows to the client —
--    correct regardless of table size, and far less data over the wire.
--
-- 2. partner_attributions' only staff-wide policy checks has_role('admin')
--    — sec_admin was never included, despite can_manage_payments() (which
--    gates the Paid Users tab itself) treating admin and sec_admin as
--    equivalent everywhere else. Verified empirically with a real sec_admin
--    account: 213 of 274 rows visible (only where they happened to also
--    own the referring partner account) — the "Partner" column silently
--    showed "—" for the other 61 real attributions.
CREATE OR REPLACE FUNCTION public.admin_paid_user_stats()
RETURNS TABLE(user_id uuid, studio_ms bigint, partner_code text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.can_manage_payments(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  SELECT
    s.user_id,
    COALESCE(SUM(s.duration_ms), 0)::bigint AS studio_ms,
    MAX(p.code) AS partner_code
  FROM public.studio_sessions s
  LEFT JOIN public.partner_attributions a ON a.user_id = s.user_id
  LEFT JOIN public.partners p ON p.id = a.partner_id
  GROUP BY s.user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_paid_user_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_paid_user_stats() TO authenticated;

DROP POLICY IF EXISTS "Admins manage attributions" ON public.partner_attributions;
CREATE POLICY "Admins manage attributions"
  ON public.partner_attributions FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role) OR public.has_role(auth.uid(), 'sec_admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role) OR public.has_role(auth.uid(), 'sec_admin'::app_role));
