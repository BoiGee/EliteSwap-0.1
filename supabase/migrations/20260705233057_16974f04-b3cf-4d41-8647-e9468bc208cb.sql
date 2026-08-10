
-- Live-decrement remaining_ms on every heartbeat so admin view, user timer, and Decart burn stay in sync.
CREATE OR REPLACE FUNCTION public.heartbeat_studio_session(p_key text, p_session_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_key_id uuid;
  v_started_at timestamptz;
  v_remaining_start bigint;
  v_elapsed bigint;
  v_new_remaining bigint;
BEGIN
  IF v_uid IS NULL OR p_session_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT id INTO v_key_id FROM public.api_keys
   WHERE key = trim(p_key) AND user_id = v_uid AND active_session_id = p_session_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM set_config('app.bypass_key_guard', 'on', true);

  UPDATE public.studio_sessions
     SET last_heartbeat_at = now()
   WHERE session_id = p_session_id AND ended_at IS NULL
   RETURNING started_at, remaining_ms_at_start
     INTO v_started_at, v_remaining_start;

  IF v_started_at IS NULL THEN
    RETURN true;
  END IF;

  -- Only metered keys (trial + $10 plan) have remaining_ms_at_start populated.
  IF v_remaining_start IS NOT NULL THEN
    v_elapsed := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - v_started_at)) * 1000)::bigint);
    v_new_remaining := GREATEST(0, v_remaining_start - v_elapsed);

    UPDATE public.api_keys
       SET remaining_ms = v_new_remaining,
           is_active = CASE WHEN v_new_remaining <= 0 THEN false ELSE is_active END,
           active_session_id = CASE WHEN v_new_remaining <= 0 THEN NULL ELSE active_session_id END,
           active_session_started_at = CASE WHEN v_new_remaining <= 0 THEN NULL ELSE active_session_started_at END,
           expires_at = CASE WHEN v_new_remaining <= 0 THEN NULL ELSE expires_at END,
           last_session_ended_at = CASE WHEN v_new_remaining <= 0 THEN now() ELSE last_session_ended_at END
     WHERE id = v_key_id;

    IF v_new_remaining <= 0 THEN
      UPDATE public.studio_sessions
         SET ended_at = now(),
             end_reason = 'exhausted',
             remaining_ms_at_end = 0,
             duration_ms = v_elapsed
       WHERE session_id = p_session_id AND ended_at IS NULL;
    END IF;
  END IF;

  RETURN true;
END;
$function$;

-- Broaden the activity window so still-active or recently-active keys always appear,
-- not only keys assigned inside p_days.
CREATE OR REPLACE FUNCTION public.admin_list_key_activity(p_days integer DEFAULT 90, p_filter text DEFAULT 'all'::text)
RETURNS TABLE(key_id uuid, user_id uuid, user_email text, label text, assigned_at timestamptz, expires_at timestamptz, remaining_ms bigint, is_active boolean, active_session_id text, is_trial boolean, sessions_count bigint, first_session_at timestamptz, last_activity_at timestamptz, total_used_ms bigint, status text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
      COALESCE(sum(
        CASE
          WHEN s.ended_at IS NULL THEN
            GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - s.started_at)) * 1000)::bigint)
          WHEN COALESCE(s.duration_ms, 0) > 0 THEN s.duration_ms
          ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (COALESCE(s.ended_at, s.last_heartbeat_at, s.started_at) - s.started_at)) * 1000)::bigint)
        END
      ), 0)::bigint AS used_ms
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
  LEFT JOIN auth.users u ON u.id = k.user_id
  LEFT JOIN agg a ON a.api_key_id = k.id
  WHERE k.assigned_at IS NOT NULL
    AND (
      k.assigned_at >= now() - make_interval(days => p_days)
      OR k.active_session_id IS NOT NULL
      OR (a.last_at IS NOT NULL AND a.last_at >= now() - make_interval(days => p_days))
    )
    AND (
      p_filter = 'all'
      OR (p_filter = 'never_used' AND COALESCE(a.cnt, 0) = 0)
      OR (p_filter = 'active'     AND k.is_active AND (k.expires_at IS NULL OR k.expires_at > now()))
      OR (p_filter = 'expired_unused' AND k.expires_at IS NOT NULL AND k.expires_at < now() AND COALESCE(a.cnt, 0) = 0)
      OR (p_filter = 'trial'      AND k.label ILIKE '%trial%')
    )
  ORDER BY COALESCE(a.last_at, k.assigned_at) DESC;
END;
$function$;
