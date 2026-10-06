-- Paid Users tab fixes:
-- 1. Partner attribution was only returned for users who had studio sessions (the query
--    started FROM studio_sessions), so a paid customer who never opened the studio showed
--    no partner. Each stat is now aggregated separately and joined on user_id.
-- 2. A session still running (or one whose end was never recorded) has duration_ms NULL and
--    counted as zero; it now counts up to its last heartbeat.
-- 3. Confirmed $10 trial purchases are returned so the tab can show trial buyers.

DROP FUNCTION IF EXISTS public.admin_paid_user_stats();

CREATE FUNCTION public.admin_paid_user_stats()
RETURNS TABLE(
  user_id uuid,
  studio_ms bigint,
  last_studio_at timestamptz,
  partner_code text,
  trial_spend_usd numeric,
  trial_count integer,
  last_trial_at timestamptz
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.can_manage_payments(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH s AS (
    SELECT ss.user_id,
           SUM(COALESCE(
             ss.duration_ms,
             GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (ss.last_heartbeat_at - ss.started_at)) * 1000))::bigint
           ))::bigint AS ms,
           MAX(ss.started_at) AS last_at
      FROM public.studio_sessions ss
     GROUP BY ss.user_id
  ),
  t AS (
    SELECT tp.user_id,
           SUM(tp.amount_usd) AS spend,
           COUNT(*)::integer AS n,
           MAX(COALESCE(tp.confirmed_at, tp.created_at)) AS last_at
      FROM public.trial_purchases tp
     WHERE tp.status = 'confirmed'
     GROUP BY tp.user_id
  ),
  a AS (
    SELECT pa.user_id, p.code
      FROM public.partner_attributions pa
      JOIN public.partners p ON p.id = pa.partner_id
  ),
  ids AS (
    SELECT s.user_id FROM s UNION SELECT t.user_id FROM t UNION SELECT a.user_id FROM a
  )
  SELECT ids.user_id,
         COALESCE(s.ms, 0)::bigint,
         s.last_at,
         a.code,
         COALESCE(t.spend, 0)::numeric,
         COALESCE(t.n, 0)::integer,
         t.last_at
    FROM ids
    LEFT JOIN s ON s.user_id = ids.user_id
    LEFT JOIN t ON t.user_id = ids.user_id
    LEFT JOIN a ON a.user_id = ids.user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_paid_user_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_paid_user_stats() TO authenticated, service_role;
