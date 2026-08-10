CREATE OR REPLACE FUNCTION public.reap_stale_provider_credential_locks(
  p_decart_key text,
  p_current_api_key_id uuid,
  p_live_window_ms integer DEFAULT 15000
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  r RECORD;
  v_min_bill bigint;
  v_live_interval interval;
  v_elapsed bigint;
  v_bill bigint;
  v_remaining bigint;
BEGIN
  IF p_decart_key IS NULL OR length(trim(p_decart_key)) = 0 THEN
    RETURN 'ok';
  END IF;

  SELECT COALESCE(handshake_floor_ms, 8000)
    INTO v_min_bill
    FROM public.studio_pricing_config
   LIMIT 1;
  IF v_min_bill IS NULL THEN
    v_min_bill := 8000;
  END IF;

  v_live_interval := make_interval(secs => GREATEST(COALESCE(p_live_window_ms, 15000), 1000)::double precision / 1000.0);

  -- Serialize all opens for the same underlying Decart credential, even when
  -- the user-facing app keys belong to different accounts.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_decart_key, 71833091));

  FOR r IN
    SELECT k.id AS api_key_id,
           k.user_id,
           k.active_session_id,
           k.remaining_ms AS key_remaining_ms,
           s.id AS studio_session_pk,
           s.started_at,
           s.last_heartbeat_at,
           COALESCE(s.remaining_ms_at_start, k.remaining_ms) AS rem_start,
           COALESCE(s.min_bill_ms, v_min_bill) AS min_bill
      FROM public.api_key_secrets sec
      JOIN public.api_keys k ON k.id = sec.api_key_id
      LEFT JOIN public.studio_sessions s
        ON s.session_id = k.active_session_id
       AND s.api_key_id = k.id
       AND s.user_id = k.user_id
       AND s.ended_at IS NULL
     WHERE sec.decart_key = p_decart_key
       AND k.id IS DISTINCT FROM p_current_api_key_id
       AND k.active_session_id IS NOT NULL
     ORDER BY k.active_session_started_at NULLS LAST
     FOR UPDATE OF k
  LOOP
    IF r.studio_session_pk IS NOT NULL
       AND r.last_heartbeat_at > now() - v_live_interval THEN
      RETURN 'studio_credential_busy';
    END IF;

    PERFORM set_config('app.bypass_key_guard', 'on', true);

    IF r.studio_session_pk IS NOT NULL THEN
      v_elapsed := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - r.started_at)) * 1000)::bigint);
      v_bill := GREATEST(v_elapsed, r.min_bill);

      IF r.rem_start IS NOT NULL THEN
        v_bill := LEAST(v_bill, r.rem_start);
        v_remaining := GREATEST(0, r.rem_start - v_bill);
      ELSE
        v_remaining := GREATEST(0, COALESCE(r.key_remaining_ms, 0) - v_bill);
      END IF;

      UPDATE public.studio_sessions AS s
         SET ended_at = now(),
             end_reason = 'provider_takeover_reap',
             remaining_ms_at_end = v_remaining,
             duration_ms = v_bill
       WHERE s.id = r.studio_session_pk
         AND s.ended_at IS NULL;

      UPDATE public.api_keys
         SET remaining_ms = CASE
               WHEN v_remaining IS NULL THEN remaining_ms
               WHEN remaining_ms IS NULL THEN v_remaining
               ELSE LEAST(remaining_ms, v_remaining)
             END,
             active_session_id = NULL,
             active_session_started_at = NULL,
             expires_at = NULL,
             last_session_ended_at = now(),
             is_active = CASE WHEN v_remaining IS NOT NULL AND v_remaining <= 0 THEN false ELSE is_active END
       WHERE id = r.api_key_id
         AND active_session_id = r.active_session_id;
    ELSE
      UPDATE public.api_keys
         SET active_session_id = NULL,
             active_session_started_at = NULL,
             expires_at = NULL,
             last_session_ended_at = now()
       WHERE id = r.api_key_id
         AND active_session_id = r.active_session_id;
    END IF;
  END LOOP;

  RETURN 'ok';
END;
$function$;

REVOKE ALL ON FUNCTION public.reap_stale_provider_credential_locks(text, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reap_stale_provider_credential_locks(text, uuid, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.mint_studio_credentials(p_key text)
RETURNS TABLE(ok boolean, reason text, decart_key text, remaining_ms bigint, label text, is_trial boolean, session_id text, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.api_keys%ROWTYPE;
  v_secret text;
  v_is_trial boolean;
  v_expired boolean;
  v_trial_exhausted boolean;
  v_foreign_exists boolean;
  v_new_session text;
  v_expires_at timestamptz;
  v_prior RECORD;
  v_prior_elapsed bigint;
  v_prior_bill bigint;
  v_prior_new_remaining bigint;
  v_min_bill bigint;
  v_provider_state text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN QUERY SELECT false, 'not_authenticated'::text, NULL::text, NULL::bigint, NULL::text, false, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT COALESCE(handshake_floor_ms, 8000) INTO v_min_bill FROM public.studio_pricing_config LIMIT 1;
  IF v_min_bill IS NULL THEN v_min_bill := 8000; END IF;

  SELECT * INTO v_row
    FROM public.api_keys
   WHERE key = trim(p_key) AND user_id = v_uid
   ORDER BY is_active DESC, created_at DESC
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    SELECT EXISTS(SELECT 1 FROM public.api_keys WHERE key = trim(p_key)) INTO v_foreign_exists;
    IF v_foreign_exists THEN
      RETURN QUERY SELECT false, 'not_owner'::text, NULL::text, NULL::bigint, NULL::text, false, NULL::text, NULL::timestamptz;
    ELSE
      RETURN QUERY SELECT false, 'key_not_found'::text, NULL::text, NULL::bigint, NULL::text, false, NULL::text, NULL::timestamptz;
    END IF;
    RETURN;
  END IF;

  v_is_trial := COALESCE(v_row.label, '') ILIKE 'free trial%'
             OR COALESCE(v_row.label, '') ILIKE 'trial%'
             OR v_row.pool_key_id IS NOT NULL;
  v_expired := v_row.expires_at IS NOT NULL AND v_row.expires_at <= now();
  v_trial_exhausted := v_is_trial AND v_row.remaining_ms IS NOT NULL AND v_row.remaining_ms <= 0;

  IF NOT v_row.is_active OR (v_is_trial AND v_expired) OR v_trial_exhausted THEN
    RETURN QUERY SELECT false, 'expired_or_inactive'::text, NULL::text, v_row.remaining_ms, v_row.label, v_is_trial, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_is_trial AND v_row.remaining_ms IS NOT NULL AND v_row.remaining_ms < 30000 THEN
    RETURN QUERY SELECT false, 'trial_time_too_low'::text, NULL::text, v_row.remaining_ms, v_row.label, v_is_trial, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_row.active_session_id IS NOT NULL THEN
    SELECT s.session_id AS prior_session_id,
           s.started_at AS started_at,
           s.last_heartbeat_at AS last_heartbeat_at,
           COALESCE(s.remaining_ms_at_start, v_row.remaining_ms) AS rem_start,
           COALESCE(s.min_bill_ms, v_min_bill) AS min_bill
      INTO v_prior
      FROM public.studio_sessions s
     WHERE s.session_id = v_row.active_session_id
       AND s.api_key_id = v_row.id
       AND s.user_id = v_uid
       AND s.ended_at IS NULL
     LIMIT 1;

    IF FOUND THEN
      IF v_prior.last_heartbeat_at > now() - interval '15 seconds' THEN
        RETURN QUERY SELECT false, 'already_active_elsewhere'::text, NULL::text, v_row.remaining_ms, v_row.label, v_is_trial, NULL::text, NULL::timestamptz;
        RETURN;
      END IF;

      PERFORM set_config('app.bypass_key_guard', 'on', true);
      v_prior_elapsed := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - v_prior.started_at)) * 1000)::bigint);
      v_prior_bill := GREATEST(v_prior_elapsed, v_prior.min_bill);
      IF v_prior.rem_start IS NOT NULL THEN
        v_prior_bill := LEAST(v_prior_bill, v_prior.rem_start);
        v_prior_new_remaining := GREATEST(0, v_prior.rem_start - v_prior_bill);
      ELSE
        v_prior_new_remaining := GREATEST(0, COALESCE(v_row.remaining_ms, 0) - v_prior_bill);
      END IF;

      UPDATE public.studio_sessions AS s
         SET ended_at = now(),
             end_reason = 'takeover_reap',
             remaining_ms_at_end = v_prior_new_remaining,
             duration_ms = v_prior_bill
       WHERE s.session_id = v_prior.prior_session_id
         AND s.api_key_id = v_row.id
         AND s.user_id = v_uid
         AND s.ended_at IS NULL;

      UPDATE public.api_keys
         SET remaining_ms = LEAST(COALESCE(remaining_ms, v_prior_new_remaining), v_prior_new_remaining),
             expires_at = NULL,
             active_session_id = NULL,
             active_session_started_at = NULL,
             last_session_ended_at = now()
       WHERE id = v_row.id
         AND user_id = v_uid;

      SELECT * INTO v_row FROM public.api_keys WHERE id = v_row.id AND user_id = v_uid FOR UPDATE;
      IF v_row.remaining_ms IS NOT NULL AND v_row.remaining_ms <= 0 THEN
        UPDATE public.api_keys SET is_active = false WHERE id = v_row.id AND user_id = v_uid;
        RETURN QUERY SELECT false, 'expired_or_inactive'::text, NULL::text, v_row.remaining_ms, v_row.label, v_is_trial, NULL::text, NULL::timestamptz;
        RETURN;
      END IF;
    ELSE
      PERFORM set_config('app.bypass_key_guard', 'on', true);
      UPDATE public.api_keys
         SET active_session_id = NULL, active_session_started_at = NULL, expires_at = NULL
       WHERE id = v_row.id
         AND user_id = v_uid;
      SELECT * INTO v_row FROM public.api_keys WHERE id = v_row.id AND user_id = v_uid FOR UPDATE;
    END IF;
  END IF;

  SELECT s.decart_key INTO v_secret
    FROM public.api_key_secrets s
   WHERE s.api_key_id = v_row.id;

  IF v_secret IS NULL THEN
    v_secret := v_row.key;
    INSERT INTO public.api_key_secrets(api_key_id, decart_key)
    VALUES (v_row.id, v_row.key)
    ON CONFLICT (api_key_id) DO NOTHING;
  END IF;

  SELECT public.reap_stale_provider_credential_locks(v_secret, v_row.id)
    INTO v_provider_state;
  IF v_provider_state <> 'ok' THEN
    RETURN QUERY SELECT false, v_provider_state, NULL::text, v_row.remaining_ms, v_row.label, v_is_trial, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  PERFORM set_config('app.bypass_key_guard', 'on', true);
  v_new_session := encode(extensions.gen_random_bytes(16), 'hex');

  IF v_row.remaining_ms IS NOT NULL AND v_row.remaining_ms > 0 THEN
    v_expires_at := now() + (v_row.remaining_ms || ' milliseconds')::interval;
    UPDATE public.api_keys
       SET expires_at = v_expires_at,
           active_session_id = v_new_session,
           active_session_started_at = now()
     WHERE id = v_row.id
       AND user_id = v_uid;
  ELSE
    v_expires_at := NULL;
    UPDATE public.api_keys
       SET active_session_id = v_new_session,
           active_session_started_at = now()
     WHERE id = v_row.id
       AND user_id = v_uid;
  END IF;

  BEGIN
    INSERT INTO public.studio_sessions(
      api_key_id, user_id, key_label, is_trial,
      session_id, started_at, last_heartbeat_at,
      remaining_ms_at_start, min_bill_ms
    ) VALUES (
      v_row.id, v_uid, v_row.label, v_is_trial,
      v_new_session, now(), now(),
      CASE WHEN v_row.remaining_ms IS NOT NULL AND v_row.remaining_ms > 0 THEN v_row.remaining_ms ELSE NULL END,
      v_min_bill
    );
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.api_keys
       SET expires_at = v_row.expires_at,
           active_session_id = v_row.active_session_id,
           active_session_started_at = v_row.active_session_started_at
     WHERE id = v_row.id
       AND user_id = v_uid;
    RETURN QUERY SELECT false, 'session_open_failed'::text, NULL::text, v_row.remaining_ms, v_row.label, v_is_trial, NULL::text, NULL::timestamptz;
    RETURN;
  END;

  BEGIN
    PERFORM public.record_studio_connect_attempt(v_row.key);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN QUERY SELECT true, NULL::text, v_secret, v_row.remaining_ms, v_row.label, v_is_trial, v_new_session, v_expires_at;
END;
$function$;

CREATE OR REPLACE FUNCTION public.start_studio_session(p_key text)
RETURNS TABLE(ok boolean, reason text, session_id text, expires_at timestamptz, remaining_ms bigint, label text, is_trial boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.api_keys%ROWTYPE;
  v_secret text;
  v_new_session text;
  v_is_trial boolean;
  v_expired boolean;
  v_trial_exhausted boolean;
  v_foreign_exists boolean;
  v_effective_remaining bigint;
  v_prior RECORD;
  v_min_bill bigint;
  v_prior_elapsed bigint;
  v_prior_bill bigint;
  v_prior_new_remaining bigint;
  v_provider_state text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN QUERY SELECT false, 'not_authenticated'::text, NULL::text, NULL::timestamptz, NULL::bigint, NULL::text, false;
    RETURN;
  END IF;

  SELECT COALESCE(handshake_floor_ms, 8000) INTO v_min_bill FROM public.studio_pricing_config LIMIT 1;
  IF v_min_bill IS NULL THEN v_min_bill := 8000; END IF;

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

  IF v_row.active_session_id IS NOT NULL THEN
    SELECT s.session_id AS prior_session_id,
           s.started_at AS started_at,
           s.last_heartbeat_at AS last_heartbeat_at,
           COALESCE(s.remaining_ms_at_start, v_row.remaining_ms) AS rem_start,
           COALESCE(s.min_bill_ms, v_min_bill) AS min_bill
      INTO v_prior
      FROM public.studio_sessions s
     WHERE s.session_id = v_row.active_session_id
       AND s.api_key_id = v_row.id
       AND s.user_id = v_uid
       AND s.ended_at IS NULL
     LIMIT 1;

    IF FOUND AND v_prior.last_heartbeat_at > now() - interval '15 seconds' THEN
      RETURN QUERY SELECT false, 'already_active_elsewhere'::text, NULL::text, NULL::timestamptz, v_row.remaining_ms, v_row.label, v_is_trial;
      RETURN;
    END IF;

    PERFORM set_config('app.bypass_key_guard', 'on', true);

    IF FOUND THEN
      v_prior_elapsed := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - v_prior.started_at)) * 1000)::bigint);
      v_prior_bill := GREATEST(v_prior_elapsed, v_prior.min_bill);
      IF v_prior.rem_start IS NOT NULL THEN
        v_prior_bill := LEAST(v_prior_bill, v_prior.rem_start);
        v_prior_new_remaining := GREATEST(0, v_prior.rem_start - v_prior_bill);
      ELSE
        v_prior_new_remaining := GREATEST(0, COALESCE(v_row.remaining_ms, 0) - v_prior_bill);
      END IF;

      UPDATE public.studio_sessions AS s
         SET ended_at = now(),
             end_reason = 'takeover_reap',
             remaining_ms_at_end = v_prior_new_remaining,
             duration_ms = v_prior_bill
       WHERE s.session_id = v_prior.prior_session_id
         AND s.api_key_id = v_row.id
         AND s.user_id = v_uid
         AND s.ended_at IS NULL;

      UPDATE public.api_keys
         SET remaining_ms = LEAST(COALESCE(remaining_ms, v_prior_new_remaining), v_prior_new_remaining),
             expires_at = NULL,
             active_session_id = NULL,
             active_session_started_at = NULL,
             last_session_ended_at = now()
       WHERE id = v_row.id
         AND user_id = v_uid;
    ELSE
      UPDATE public.api_keys
         SET active_session_id = NULL,
             active_session_started_at = NULL,
             expires_at = NULL
       WHERE id = v_row.id
         AND user_id = v_uid;
    END IF;

    SELECT * INTO v_row FROM public.api_keys WHERE id = v_row.id AND user_id = v_uid FOR UPDATE;

    IF v_row.remaining_ms IS NOT NULL AND v_row.remaining_ms <= 0 THEN
      UPDATE public.api_keys SET is_active = false WHERE id = v_row.id AND user_id = v_uid;
      RETURN QUERY SELECT false, 'expired_or_inactive'::text, NULL::text, NULL::timestamptz, v_row.remaining_ms, v_row.label, v_is_trial;
      RETURN;
    END IF;
  END IF;

  SELECT s.decart_key INTO v_secret
    FROM public.api_key_secrets s
   WHERE s.api_key_id = v_row.id;

  IF v_secret IS NULL THEN
    v_secret := v_row.key;
    INSERT INTO public.api_key_secrets(api_key_id, decart_key)
    VALUES (v_row.id, v_row.key)
    ON CONFLICT (api_key_id) DO NOTHING;
  END IF;

  SELECT public.reap_stale_provider_credential_locks(v_secret, v_row.id)
    INTO v_provider_state;
  IF v_provider_state <> 'ok' THEN
    RETURN QUERY SELECT false, v_provider_state, NULL::text, NULL::timestamptz, v_row.remaining_ms, v_row.label, v_is_trial;
    RETURN;
  END IF;

  PERFORM set_config('app.bypass_key_guard', 'on', true);
  v_new_session := encode(extensions.gen_random_bytes(16), 'hex');

  IF v_row.remaining_ms IS NOT NULL AND v_row.remaining_ms > 0 THEN
    v_effective_remaining := v_row.remaining_ms;
    UPDATE public.api_keys
       SET expires_at = now() + (v_row.remaining_ms || ' milliseconds')::interval,
           active_session_id = v_new_session,
           active_session_started_at = now()
     WHERE id = v_row.id
       AND user_id = v_uid;
  ELSE
    v_effective_remaining := NULL;
    UPDATE public.api_keys
       SET active_session_id = v_new_session,
           active_session_started_at = now()
     WHERE id = v_row.id
       AND user_id = v_uid;
  END IF;

  INSERT INTO public.studio_sessions(
    api_key_id, user_id, key_label, is_trial,
    session_id, started_at, last_heartbeat_at,
    remaining_ms_at_start, min_bill_ms
  ) VALUES (
    v_row.id, v_uid, v_row.label, v_is_trial,
    v_new_session, now(), now(),
    v_effective_remaining, v_min_bill
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