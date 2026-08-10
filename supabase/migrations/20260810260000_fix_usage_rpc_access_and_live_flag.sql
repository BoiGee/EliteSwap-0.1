-- Usage tab audit found two real bugs in admin_paid_user_usage(), both
-- verified against live data/config before fixing:
--
-- 1. The RPC checked has_role('admin') only, but Admin.tsx's own
--    MODERATOR_TABS list explicitly includes "usage" — moderators and
--    sec_admins are meant to see this tab. Verified empirically with a
--    real sec_admin account: every call raised "access denied". The tab
--    was completely broken (error toast only, zero data) for every staff
--    member who isn't a full admin.
--
-- 2. is_currently_live was computed only from sessions inside the
--    p_from/p_to filter window (BOOL_OR(ended_at IS NULL) inside the same
--    date-filtered CTE as the session stats). Set a date range that
--    excludes today (e.g. "last week"), and a user's genuinely-live
--    session right now gets silently excluded from that CTE entirely —
--    their live flag flips to false. Combined with the "Only live now"
--    toggle, filtering by any past date range made it show nobody, even
--    during real peak usage. Live status is now computed from a separate,
--    date-range-independent subquery — filtering by date affects the
--    session stats, not whether someone is live right now.
CREATE OR REPLACE FUNCTION public.admin_paid_user_usage(p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_include_trial boolean DEFAULT true)
 RETURNS TABLE(user_id uuid, email text, display_name text, total_sessions bigint, total_duration_ms bigint, first_session_at timestamp with time zone, last_session_at timestamp with time zone, avg_duration_ms bigint, is_currently_live boolean, first_payment_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_staff() THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH paid AS (
    SELECT p.user_id, MIN(p.created_at) AS first_payment_at
    FROM payments p
    WHERE p.status = 'confirmed'
    GROUP BY p.user_id
  ),
  sess AS (
    SELECT
      s.user_id,
      COUNT(*)::bigint AS total_sessions,
      COALESCE(SUM(
        COALESCE(s.duration_ms, (EXTRACT(EPOCH FROM (now() - s.started_at)) * 1000)::bigint)
      ), 0)::bigint AS total_duration_ms,
      MIN(s.started_at) AS first_session_at,
      MAX(COALESCE(s.last_heartbeat_at, s.started_at)) AS last_session_at
    FROM studio_sessions s
    WHERE (p_from IS NULL OR s.started_at >= p_from)
      AND (p_to IS NULL OR s.started_at <= p_to)
      AND (p_include_trial OR s.is_trial = false)
    GROUP BY s.user_id
  ),
  live AS (
    -- Deliberately independent of p_from/p_to — whether someone is live
    -- right now shouldn't depend on which reporting window is selected.
    SELECT s.user_id, true AS is_currently_live
    FROM studio_sessions s
    WHERE s.ended_at IS NULL
      AND (p_include_trial OR s.is_trial = false)
    GROUP BY s.user_id
  )
  SELECT
    paid.user_id,
    pr.email,
    pr.display_name,
    COALESCE(sess.total_sessions, 0)::bigint,
    COALESCE(sess.total_duration_ms, 0)::bigint,
    sess.first_session_at,
    sess.last_session_at,
    CASE WHEN COALESCE(sess.total_sessions, 0) > 0
         THEN (sess.total_duration_ms / sess.total_sessions)::bigint
         ELSE 0::bigint END,
    COALESCE(live.is_currently_live, false),
    paid.first_payment_at
  FROM paid
  LEFT JOIN sess ON sess.user_id = paid.user_id
  LEFT JOIN live ON live.user_id = paid.user_id
  LEFT JOIN profiles pr ON pr.user_id = paid.user_id;
END;
$function$;
