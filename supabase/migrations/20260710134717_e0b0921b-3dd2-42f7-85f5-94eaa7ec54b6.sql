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
  v_resume_id text;
  v_resume_started timestamptz;
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

  -- RESUME PATH: if the same user just paused a session on this key within the
  -- last 60s (typical brief reconnect / accidental double-click / SDK blip),
  -- re-open that same studio_sessions row instead of inserting a new one so
  -- the Admin Live tab and Key Activity history show one continuous session.
  SELECT ss.session_id, ss.started_at
    INTO v_resume_id, v_resume_started
    FROM public.studio_sessions ss
   WHERE ss.api_key_id = v_row.id
     AND ss.user_id = v_uid
     AND ss.ended_at IS NOT NULL
     AND ss.ended_at > now() - interval '60 seconds'
     AND ss.end_reason IN ('user_pause', 'orphaned_auto')
   ORDER BY ss.ended_at DESC
   LIMIT 1;

  IF v_resume_id IS NOT NULL THEN
    -- Re-open the same session row.
    UPDATE public.studio_sessions
       SET ended_at = NULL,
           end_reason = NULL,
           duration_ms = NULL,
           remaining_ms_at_end = NULL,
           last_heartbeat_at = now()
     WHERE session_id = v_resume_id;

    IF v_row.remaining_ms IS NOT NULL AND v_row.remaining_ms > 0 THEN
      v_effective_remaining := v_row.remaining_ms;
      UPDATE public.api_keys
         SET expires_at = now() + (v_row.remaining_ms || ' milliseconds')::interval,
             active_session_id = v_resume_id,
             active_session_started_at = v_resume_started
       WHERE id = v_row.id;
    ELSE
      v_effective_remaining := NULL;
      UPDATE public.api_keys
         SET active_session_id = v_resume_id,
             active_session_started_at = v_resume_started
       WHERE id = v_row.id;
    END IF;

    IF v_effective_remaining IS NOT NULL THEN
      RETURN QUERY SELECT true, 'resumed'::text, v_resume_id,
               now() + (v_effective_remaining || ' milliseconds')::interval,
               v_effective_remaining, v_row.label, v_is_trial;
    ELSE
      RETURN QUERY SELECT true, 'resumed_no_timer'::text, v_resume_id, NULL::timestamptz, NULL::bigint, v_row.label, v_is_trial;
    END IF;
    RETURN;
  END IF;

  -- FRESH PATH: no recent session to resume, insert a new one.
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