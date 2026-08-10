
CREATE OR REPLACE FUNCTION public.admin_list_key_activity(p_days int DEFAULT 90, p_filter text DEFAULT 'all')
RETURNS TABLE (
  key_id uuid,
  user_id uuid,
  user_email text,
  label text,
  assigned_at timestamptz,
  expires_at timestamptz,
  remaining_ms bigint,
  is_active boolean,
  active_session_id text,
  is_trial boolean,
  sessions_count bigint,
  first_session_at timestamptz,
  last_activity_at timestamptz,
  total_used_ms bigint,
  status text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'sec_admin')
    OR public.has_role(auth.uid(), 'moderator')
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  WITH agg AS (
    SELECT
      s.api_key_id,
      count(*)::bigint AS cnt,
      min(s.started_at) AS first_at,
      max(COALESCE(s.ended_at, s.last_heartbeat_at, s.started_at)) AS last_at,
      COALESCE(sum(s.duration_ms), 0)::bigint AS used_ms
    FROM public.studio_sessions s
    WHERE s.api_key_id IS NOT NULL
    GROUP BY s.api_key_id
  )
  SELECT
    k.id AS key_id,
    k.user_id,
    u.email::text AS user_email,
    k.label,
    k.assigned_at,
    k.expires_at,
    k.remaining_ms,
    k.is_active,
    k.active_session_id,
    (k.label ILIKE '%trial%') AS is_trial,
    COALESCE(a.cnt, 0) AS sessions_count,
    a.first_at AS first_session_at,
    a.last_at AS last_activity_at,
    COALESCE(a.used_ms, 0) AS total_used_ms,
    CASE
      WHEN k.active_session_id IS NOT NULL THEN 'in_use'
      WHEN COALESCE(k.remaining_ms, 0) <= 0 THEN 'exhausted'
      WHEN k.expires_at IS NOT NULL AND k.expires_at < now() AND COALESCE(a.cnt, 0) = 0 THEN 'expired_unused'
      WHEN k.expires_at IS NOT NULL AND k.expires_at < now() THEN 'expired_used'
      WHEN k.is_active THEN 'active'
      ELSE 'inactive'
    END AS status
  FROM public.api_keys k
  LEFT JOIN agg a ON a.api_key_id = k.id
  LEFT JOIN auth.users u ON u.id = k.user_id
  WHERE k.user_id IS NOT NULL
    AND k.assigned_at IS NOT NULL
    AND k.assigned_at >= now() - make_interval(days => p_days)
    AND (
      p_filter = 'all'
      OR (p_filter = 'never_used' AND COALESCE(a.cnt, 0) = 0 AND k.expires_at < now())
      OR (p_filter = 'active' AND k.is_active AND (k.expires_at IS NULL OR k.expires_at > now()))
      OR (p_filter = 'expired_unused' AND COALESCE(a.cnt, 0) = 0 AND k.expires_at < now())
      OR (p_filter = 'trial' AND k.label ILIKE '%trial%')
    )
  ORDER BY k.assigned_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_key_activity(int, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_key_activity(int, text) TO authenticated;
