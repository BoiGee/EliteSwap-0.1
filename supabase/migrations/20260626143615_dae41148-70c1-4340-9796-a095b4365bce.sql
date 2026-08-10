
-- 1) check_studio_session: broaden trial detection + add trial_time_too_low.
CREATE OR REPLACE FUNCTION public.check_studio_session(p_key text)
RETURNS TABLE(ok boolean, reason text, remaining_ms bigint, label text, is_trial boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.api_keys%ROWTYPE;
  v_age_ms bigint;
  v_is_trial boolean;
  v_expired boolean;
  v_trial_exhausted boolean;
  v_foreign_exists boolean;
BEGIN
  IF v_uid IS NULL THEN
    RETURN QUERY SELECT false, 'not_authenticated'::text, NULL::bigint, NULL::text, false;
    RETURN;
  END IF;

  SELECT * INTO v_row
    FROM public.api_keys
   WHERE key = trim(p_key) AND user_id = v_uid
   ORDER BY is_active DESC, created_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    SELECT EXISTS(SELECT 1 FROM public.api_keys WHERE key = trim(p_key)) INTO v_foreign_exists;
    IF v_foreign_exists THEN
      RETURN QUERY SELECT false, 'not_owner'::text, NULL::bigint, NULL::text, false;
    ELSE
      RETURN QUERY SELECT false, 'key_not_found'::text, NULL::bigint, NULL::text, false;
    END IF;
    RETURN;
  END IF;

  v_is_trial := COALESCE(v_row.label, '') ILIKE 'free trial%'
             OR COALESCE(v_row.label, '') ILIKE 'trial%'
             OR v_row.pool_key_id IS NOT NULL;
  v_expired := v_row.expires_at IS NOT NULL AND v_row.expires_at <= now();
  v_trial_exhausted := v_is_trial AND v_row.remaining_ms IS NOT NULL AND v_row.remaining_ms <= 0;

  IF NOT v_row.is_active OR (v_is_trial AND v_expired) OR v_trial_exhausted THEN
    RETURN QUERY SELECT false, 'expired_or_inactive'::text, v_row.remaining_ms, v_row.label, v_is_trial;
    RETURN;
  END IF;

  -- Trials need at least 30s for a stable session start.
  IF v_is_trial AND v_row.remaining_ms IS NOT NULL AND v_row.remaining_ms < 30000 THEN
    RETURN QUERY SELECT false, 'trial_time_too_low'::text, v_row.remaining_ms, v_row.label, v_is_trial;
    RETURN;
  END IF;

  IF v_row.active_session_id IS NOT NULL AND v_row.active_session_started_at IS NOT NULL THEN
    v_age_ms := EXTRACT(EPOCH FROM (now() - v_row.active_session_started_at)) * 1000;
    IF v_age_ms < 90000 THEN
      RETURN QUERY SELECT false, 'already_active_elsewhere'::text, v_row.remaining_ms, v_row.label, v_is_trial;
      RETURN;
    END IF;
  END IF;

  RETURN QUERY SELECT true, NULL::text, v_row.remaining_ms, v_row.label, v_is_trial;
END;
$function$;

-- 2) start_studio_session: same low-time guard.
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

  v_new_session := encode(extensions.gen_random_bytes(16), 'hex');

  PERFORM set_config('app.bypass_key_guard', 'on', true);

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

-- 3) reaper: refund time when session had no real heartbeat.
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
  v_no_real_heartbeat boolean;
BEGIN
  PERFORM set_config('app.bypass_key_guard', 'on', true);

  FOR r IN
    SELECT s.*, k.expires_at AS key_expires_at, k.remaining_ms AS key_remaining_ms, k.active_session_id AS key_active_session
    FROM public.studio_sessions s
    LEFT JOIN public.api_keys k ON k.id = s.api_key_id
    WHERE s.ended_at IS NULL
      AND (
        s.last_heartbeat_at < now() - interval '2 minutes'
        OR (k.expires_at IS NOT NULL AND k.expires_at <= now())
        OR k.active_session_id IS DISTINCT FROM s.session_id
      )
  LOOP
    v_no_real_heartbeat := r.last_heartbeat_at <= r.started_at + interval '5 seconds';

    IF v_no_real_heartbeat AND r.remaining_ms_at_start IS NOT NULL THEN
      v_remaining := r.remaining_ms_at_start;
    ELSIF r.key_expires_at IS NOT NULL THEN
      v_remaining := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (r.key_expires_at - now())) * 1000)::bigint);
    ELSE
      v_remaining := r.key_remaining_ms;
    END IF;

    UPDATE public.studio_sessions
       SET ended_at = COALESCE(last_heartbeat_at, now()),
           end_reason = CASE
             WHEN r.key_expires_at IS NOT NULL AND r.key_expires_at <= now() THEN 'expired'
             ELSE 'orphaned_auto'
           END,
           remaining_ms_at_end = v_remaining,
           duration_ms = CASE
             WHEN v_no_real_heartbeat THEN 0
             ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (COALESCE(last_heartbeat_at, now()) - started_at)) * 1000)::bigint)
           END
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

-- 4) One-time refund: any past sessions ended as 'orphaned_auto' with 0 duration
-- and a known remaining_ms_at_start that left their key shortchanged.
DO $$
DECLARE
  r RECORD;
BEGIN
  PERFORM set_config('app.bypass_key_guard', 'on', true);
  FOR r IN
    SELECT s.api_key_id, s.remaining_ms_at_start, k.remaining_ms AS key_remaining_ms, k.is_active
      FROM public.studio_sessions s
      JOIN public.api_keys k ON k.id = s.api_key_id
     WHERE s.end_reason = 'orphaned_auto'
       AND COALESCE(s.duration_ms, 0) = 0
       AND s.remaining_ms_at_start IS NOT NULL
       AND s.remaining_ms_at_start > COALESCE(k.remaining_ms, 0)
       AND k.active_session_id IS NULL
       AND k.last_session_ended_at IS NULL
  LOOP
    UPDATE public.api_keys
       SET remaining_ms = r.remaining_ms_at_start,
           is_active = true
     WHERE id = r.api_key_id;
  END LOOP;
END $$;
