
CREATE OR REPLACE FUNCTION public.admin_paid_user_usage(
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_include_trial boolean DEFAULT true
)
RETURNS TABLE (
  user_id uuid,
  email text,
  display_name text,
  total_sessions bigint,
  total_duration_ms bigint,
  first_session_at timestamptz,
  last_session_at timestamptz,
  avg_duration_ms bigint,
  is_currently_live boolean,
  first_payment_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT has_role('admin'::app_role) THEN
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
      MAX(COALESCE(s.last_heartbeat_at, s.started_at)) AS last_session_at,
      BOOL_OR(s.ended_at IS NULL) AS is_currently_live
    FROM studio_sessions s
    WHERE (p_from IS NULL OR s.started_at >= p_from)
      AND (p_to IS NULL OR s.started_at <= p_to)
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
    COALESCE(sess.is_currently_live, false),
    paid.first_payment_at
  FROM paid
  LEFT JOIN sess ON sess.user_id = paid.user_id
  LEFT JOIN profiles pr ON pr.user_id = paid.user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_paid_user_usage(timestamptz, timestamptz, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_paid_user_usage(timestamptz, timestamptz, boolean) TO authenticated;
