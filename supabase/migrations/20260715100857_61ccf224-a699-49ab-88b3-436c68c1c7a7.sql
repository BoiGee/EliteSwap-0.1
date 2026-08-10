-- A) Reaper: always deduct wall-clock, tighter 20s stale window
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
        s.last_heartbeat_at < now() - interval '20 seconds'
        OR (k.expires_at IS NOT NULL AND k.expires_at <= now())
        OR k.active_session_id IS DISTINCT FROM s.session_id
      )
  LOOP
    v_end_ts := now();
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

-- B) start_studio_session: drop 60s resume-same-row branch
CREATE OR REPLACE FUNCTION public.start_studio_session(p_key text)
 RETURNS TABLE(ok boolean, reason text, session_id text, expires_at timestamp with time zone, remaining_ms bigint, label text, is_trial boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.api_keys%ROWTYPE;
  v_new_session text;
  v_age_ms bigint;
  v_is_trial boolean;
  v_expired boolean;
  v_trial_exhausted boolean;
  v_foreign_exists boolean;
  v_effective_remaining bigint;
BEGIN
  IF v_uid IS NULL THEN
    RETURN QUERY SELECT false, 'not_authenticated'::text, NULL::text, NULL::timestamptz, NULL::bigint, NULL::text, false;
    RETURN;
  END IF;

  SELECT * INTO v_row
    FROM public.api_keys
   WHERE key = trim(p_key) AND user_id = v_uid
   ORDER BY is_active DESC, created_at DESC
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    SELECT EXISTS(SELECT 1 FROM public.api_keys WHERE key = trim(p_key)) INTO v_foreign_exists;
    IF v_foreign_exists THEN
      RETURN QUERY SELECT false, 'not_owner'::text, NULL::text, NULL::timestamptz, NULL::bigint, NULL::text, false;
    ELSE
      RETURN QUERY SELECT false, 'key_not_found'::text, NULL::text, NULL::timestamptz, NULL::bigint, NULL::text, false;
    END IF;
    RETURN;
  END IF;

  v_is_trial := COALESCE(v_row.label, '') ILIKE 'free trial%'
             OR COALESCE(v_row.label, '') ILIKE 'trial%'
             OR v_row.pool_key_id IS NOT NULL;
  v_expired := v_row.expires_at IS NOT NULL AND v_row.expires_at <= now();
  v_trial_exhausted := v_is_trial AND v_row.remaining_ms IS NOT NULL AND v_row.remaining_ms <= 0;

  IF NOT v_row.is_active OR (v_is_trial AND v_expired) OR v_trial_exhausted THEN
    RETURN QUERY SELECT false, 'expired_or_inactive'::text, NULL::text, NULL::timestamptz, v_row.remaining_ms, v_row.label, v_is_trial;
    RETURN;
  END IF;

  IF v_is_trial AND v_row.remaining_ms IS NOT NULL AND v_row.remaining_ms < 30000 THEN
    RETURN QUERY SELECT false, 'trial_time_too_low'::text, NULL::text, NULL::timestamptz, v_row.remaining_ms, v_row.label, v_is_trial;
    RETURN;
  END IF;

  IF v_row.active_session_id IS NOT NULL AND v_row.active_session_started_at IS NOT NULL THEN
    v_age_ms := EXTRACT(EPOCH FROM (now() - v_row.active_session_started_at)) * 1000;
    IF v_age_ms < 90000 THEN
      RETURN QUERY SELECT false, 'already_active_elsewhere'::text, NULL::text, NULL::timestamptz, v_row.remaining_ms, v_row.label, v_is_trial;
      RETURN;
    END IF;
  END IF;

  PERFORM set_config('app.bypass_key_guard', 'on', true);

  -- Always fresh path (resume-within-60s removed to prevent balance rewinds)
  v_new_session := encode(extensions.gen_random_bytes(16), 'hex');

  IF v_row.remaining_ms IS NOT NULL AND v_row.remaining_ms > 0 THEN
    v_effective_remaining := v_row.remaining_ms;
    UPDATE public.api_keys
       SET expires_at = now() + (v_row.remaining_ms || ' milliseconds')::interval,
           active_session_id = v_new_session,
           active_session_started_at = now()
     WHERE id = v_row.id;
  ELSE
    v_effective_remaining := NULL;
    UPDATE public.api_keys
       SET active_session_id = v_new_session,
           active_session_started_at = now()
     WHERE id = v_row.id;
  END IF;

  INSERT INTO public.studio_sessions(
    api_key_id, user_id, key_label, is_trial,
    session_id, started_at, last_heartbeat_at,
    remaining_ms_at_start
  ) VALUES (
    v_row.id, v_uid, v_row.label, v_is_trial,
    v_new_session, now(), now(),
    v_effective_remaining
  );

  IF v_effective_remaining IS NOT NULL THEN
    RETURN QUERY SELECT true, 'ok'::text, v_new_session,
             now() + (v_effective_remaining || ' milliseconds')::interval,
             v_effective_remaining, v_row.label, v_is_trial;
  ELSE
    RETURN QUERY SELECT true, 'ok_no_timer'::text, v_new_session, NULL::timestamptz, NULL::bigint, v_row.label, v_is_trial;
  END IF;
END;
$function$;

-- C) heartbeat: clamp to LEAST(new, existing) so remaining_ms is monotone-decreasing
CREATE OR REPLACE FUNCTION public.heartbeat_studio_session(p_key text, p_session_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_key_id uuid;
  v_current_remaining bigint;
  v_started_at timestamptz;
  v_remaining_start bigint;
  v_elapsed bigint;
  v_new_remaining bigint;
BEGIN
  IF v_uid IS NULL OR p_session_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT id, remaining_ms INTO v_key_id, v_current_remaining
    FROM public.api_keys
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

  IF v_remaining_start IS NOT NULL THEN
    v_elapsed := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - v_started_at)) * 1000)::bigint);
    v_new_remaining := GREATEST(0, v_remaining_start - v_elapsed);

    IF v_current_remaining IS NOT NULL THEN
      v_new_remaining := LEAST(v_new_remaining, v_current_remaining);
    END IF;

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

-- Tighten pg_cron schedule from 1min to 15s
DO $$
BEGIN
  PERFORM cron.unschedule('reap-orphaned-studio-sessions');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'reap-orphaned-studio-sessions',
  '15 seconds',
  $$ SELECT public.reap_orphaned_studio_sessions(); $$
);