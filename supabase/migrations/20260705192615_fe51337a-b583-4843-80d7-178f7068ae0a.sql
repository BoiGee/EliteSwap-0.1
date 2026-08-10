
-- 1) heartbeat: do NOT reset active_session_started_at (it corrupts elapsed-time math)
CREATE OR REPLACE FUNCTION public.heartbeat_studio_session(p_key text, p_session_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row_id uuid;
BEGIN
  IF v_uid IS NULL OR p_session_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT id INTO v_row_id FROM public.api_keys
   WHERE key = trim(p_key) AND user_id = v_uid AND active_session_id = p_session_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM set_config('app.bypass_key_guard', 'on', true);

  UPDATE public.studio_sessions
     SET last_heartbeat_at = now()
   WHERE session_id = p_session_id AND ended_at IS NULL;

  RETURN true;
END;
$function$;

-- 2) reaper: always deduct real elapsed time. remove the "no real heartbeat => refund" loophole.
CREATE OR REPLACE FUNCTION public.reap_orphaned_studio_sessions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer := 0;
  r RECORD;
  v_remaining bigint;
  v_end_ts timestamptz;
  v_duration bigint;
BEGIN
  PERFORM set_config('app.bypass_key_guard', 'on', true);

  FOR r IN
    SELECT s.*, k.expires_at AS key_expires_at, k.remaining_ms AS key_remaining_ms, k.active_session_id AS key_active_session
    FROM public.studio_sessions s
    LEFT JOIN public.api_keys k ON k.id = s.api_key_id
    WHERE s.ended_at IS NULL
      AND (
        s.last_heartbeat_at < now() - interval '90 seconds'
        OR (k.expires_at IS NOT NULL AND k.expires_at <= now())
        OR k.active_session_id IS DISTINCT FROM s.session_id
      )
  LOOP
    -- End timestamp = last heartbeat we actually saw, bounded by the key expiry.
    v_end_ts := COALESCE(r.last_heartbeat_at, r.started_at);
    IF r.key_expires_at IS NOT NULL AND r.key_expires_at < v_end_ts THEN
      v_end_ts := r.key_expires_at;
    END IF;

    v_duration := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (v_end_ts - r.started_at)) * 1000)::bigint);
    IF r.remaining_ms_at_start IS NOT NULL THEN
      v_duration := LEAST(v_duration, r.remaining_ms_at_start);
      v_remaining := GREATEST(0, r.remaining_ms_at_start - v_duration);
    ELSIF r.key_expires_at IS NOT NULL THEN
      v_remaining := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (r.key_expires_at - now())) * 1000)::bigint);
    ELSE
      v_remaining := r.key_remaining_ms;
    END IF;

    UPDATE public.studio_sessions
       SET ended_at = v_end_ts,
           end_reason = CASE
             WHEN r.key_expires_at IS NOT NULL AND r.key_expires_at <= now() THEN 'expired'
             ELSE 'orphaned_auto'
           END,
           remaining_ms_at_end = v_remaining,
           duration_ms = v_duration
     WHERE id = r.id;

    IF r.key_active_session = r.session_id THEN
      UPDATE public.api_keys
         SET active_session_id = NULL,
             active_session_started_at = NULL,
             last_session_ended_at = now(),
             remaining_ms = v_remaining,
             expires_at = NULL,
             is_active = CASE WHEN v_remaining <= 0 THEN false ELSE is_active END
       WHERE id = r.api_key_id;
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$;

-- 3) admin_list_key_activity: include live time from open sessions and back-fill 0-duration rows on the fly
CREATE OR REPLACE FUNCTION public.admin_list_key_activity(p_days integer DEFAULT 90, p_filter text DEFAULT 'all'::text)
RETURNS TABLE(key_id uuid, user_id uuid, user_email text, label text, assigned_at timestamp with time zone, expires_at timestamp with time zone, remaining_ms bigint, is_active boolean, active_session_id text, is_trial boolean, sessions_count bigint, first_session_at timestamp with time zone, last_activity_at timestamp with time zone, total_used_ms bigint, status text)
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
          -- Live session: count time from start to now
          WHEN s.ended_at IS NULL THEN
            GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - s.started_at)) * 1000)::bigint)
          -- Recorded duration if non-zero
          WHEN COALESCE(s.duration_ms, 0) > 0 THEN s.duration_ms
          -- Fallback for legacy 0-duration orphans: infer from heartbeat
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
    AND k.assigned_at >= now() - make_interval(days => p_days)
    AND (
      p_filter = 'all'
      OR (p_filter = 'never_used' AND COALESCE(a.cnt, 0) = 0)
      OR (p_filter = 'active'     AND k.is_active AND (k.expires_at IS NULL OR k.expires_at > now()))
      OR (p_filter = 'expired_unused' AND k.expires_at IS NOT NULL AND k.expires_at < now() AND COALESCE(a.cnt, 0) = 0)
      OR (p_filter = 'trial'      AND k.label ILIKE '%trial%')
    )
  ORDER BY k.assigned_at DESC;
END;
$function$;

-- 4) Backfill: recompute duration on past orphaned sessions where duration_ms is 0 but we have a real heartbeat gap
UPDATE public.studio_sessions
   SET duration_ms = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (COALESCE(ended_at, last_heartbeat_at) - started_at)) * 1000)::bigint)
 WHERE ended_at IS NOT NULL
   AND COALESCE(duration_ms, 0) = 0
   AND last_heartbeat_at > started_at + interval '1 second';

-- 5) Recompute trial-key balances for keys whose recorded usage exceeds current balance state
--    (only for trial keys, only when the key is idle, to avoid stepping on live sessions).
DO $$
DECLARE
  r RECORD;
  used bigint;
  original bigint := 240000; -- $10 trial default = 4 minutes
BEGIN
  PERFORM set_config('app.bypass_key_guard', 'on', true);
  FOR r IN
    SELECT k.id, k.remaining_ms
      FROM public.api_keys k
     WHERE k.label ILIKE '%trial%'
       AND k.active_session_id IS NULL
       AND k.remaining_ms IS NOT NULL
  LOOP
    SELECT COALESCE(SUM(
      CASE
        WHEN COALESCE(s.duration_ms, 0) > 0 THEN s.duration_ms
        ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (COALESCE(s.ended_at, s.last_heartbeat_at, s.started_at) - s.started_at)) * 1000)::bigint)
      END
    ), 0)
      INTO used
      FROM public.studio_sessions s
     WHERE s.api_key_id = r.id;

    IF used > (original - r.remaining_ms) THEN
      UPDATE public.api_keys
         SET remaining_ms = GREATEST(0, original - used),
             is_active = CASE WHEN (original - used) <= 0 THEN false ELSE is_active END
       WHERE id = r.id;
    END IF;
  END LOOP;
END $$;
