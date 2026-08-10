
-- Round 5: close remaining studio time-logic money leaks.
-- 1) pause uses config-driven handshake floor (not hardcoded 3s)
-- 2) heartbeat roll-debits api_keys.remaining_ms every tick
-- 3) live-window derives from studio_pricing_config.reap_stale_ms everywhere
-- 4) reaper cadence tightened to 2s

-- ---------- A. pause_studio_session ----------
CREATE OR REPLACE FUNCTION public.pause_studio_session(p_key text, p_session_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.api_keys%ROWTYPE;
  v_session RECORD;
  v_elapsed bigint;
  v_bill bigint;
  v_remaining bigint;
  v_will_deactivate boolean := false;
  v_min_bill bigint;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;

  SELECT COALESCE(handshake_floor_ms, 8000) INTO v_min_bill
    FROM public.studio_pricing_config LIMIT 1;
  IF v_min_bill IS NULL THEN v_min_bill := 8000; END IF;

  SELECT * INTO v_row FROM public.api_keys
   WHERE key = trim(p_key) AND user_id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found_or_not_owner');
  END IF;

  IF v_row.active_session_id IS DISTINCT FROM p_session_id THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'lock_not_held');
  END IF;

  SELECT s.started_at, s.remaining_ms_at_start, COALESCE(s.min_bill_ms, v_min_bill) AS min_bill
    INTO v_session
    FROM public.studio_sessions s
   WHERE s.session_id = p_session_id
     AND s.api_key_id = v_row.id
     AND s.user_id = v_uid
     AND s.ended_at IS NULL
   LIMIT 1;

  PERFORM set_config('app.bypass_key_guard', 'on', true);

  IF v_session.started_at IS NOT NULL THEN
    v_elapsed := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - v_session.started_at)) * 1000)::bigint);
    v_bill := GREATEST(v_elapsed, v_session.min_bill);
  ELSE
    v_bill := 0;
  END IF;

  IF v_session.remaining_ms_at_start IS NOT NULL THEN
    v_bill := LEAST(v_bill, v_session.remaining_ms_at_start);
    v_remaining := GREATEST(0, v_session.remaining_ms_at_start - v_bill);
  ELSIF v_row.expires_at IS NOT NULL THEN
    v_remaining := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (v_row.expires_at - now())) * 1000)::bigint);
    IF v_row.remaining_ms IS NOT NULL THEN
      v_remaining := LEAST(v_remaining, GREATEST(0, v_row.remaining_ms - v_bill));
    END IF;
  ELSIF v_row.remaining_ms IS NOT NULL THEN
    v_remaining := GREATEST(0, v_row.remaining_ms - v_bill);
  ELSE
    v_remaining := NULL;
  END IF;

  v_will_deactivate := v_remaining IS NOT NULL AND v_remaining <= 0;

  UPDATE public.api_keys
     SET remaining_ms = CASE
           WHEN v_remaining IS NULL THEN remaining_ms
           WHEN remaining_ms IS NULL THEN v_remaining
           ELSE LEAST(remaining_ms, v_remaining)
         END,
         expires_at = NULL,
         active_session_id = NULL,
         active_session_started_at = NULL,
         last_session_ended_at = now(),
         is_active = CASE WHEN v_will_deactivate THEN false ELSE is_active END
   WHERE id = v_row.id
     AND user_id = v_uid;

  UPDATE public.studio_sessions AS s
     SET ended_at = now(),
         end_reason = 'user_pause',
         remaining_ms_at_end = v_remaining,
         duration_ms = COALESCE(v_bill, 0)
   WHERE s.session_id = p_session_id
     AND s.api_key_id = v_row.id
     AND s.user_id = v_uid
     AND s.ended_at IS NULL;

  RETURN jsonb_build_object('ok', true, 'reason', 'paused',
                            'remaining_ms', v_remaining,
                            'deactivated', v_will_deactivate);
END;
$function$;

-- ---------- B. heartbeat_studio_session (roll-debit + immediate close on exhaustion) ----------
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
  v_min_bill bigint;
  v_grace bigint;
  v_elapsed bigint;
  v_new_remaining bigint;
  v_overrun boolean := false;
  v_bill bigint;
BEGIN
  IF v_uid IS NULL OR p_session_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT id, remaining_ms INTO v_key_id, v_current_remaining
    FROM public.api_keys
   WHERE key = trim(p_key)
     AND user_id = v_uid
     AND active_session_id = p_session_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT COALESCE(heartbeat_grace_ms, 1500), COALESCE(handshake_floor_ms, 8000)
    INTO v_grace, v_min_bill
    FROM public.studio_pricing_config LIMIT 1;
  IF v_grace IS NULL THEN v_grace := 1500; END IF;
  IF v_min_bill IS NULL THEN v_min_bill := 8000; END IF;

  PERFORM set_config('app.bypass_key_guard', 'on', true);

  UPDATE public.studio_sessions AS s
     SET last_heartbeat_at = now()
   WHERE s.session_id = p_session_id
     AND s.api_key_id = v_key_id
     AND s.user_id = v_uid
     AND s.ended_at IS NULL
   RETURNING s.started_at, s.remaining_ms_at_start, COALESCE(s.min_bill_ms, v_min_bill)
     INTO v_started_at, v_remaining_start, v_min_bill;

  IF v_started_at IS NULL THEN
    RETURN false;
  END IF;

  IF v_remaining_start IS NOT NULL THEN
    v_elapsed := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - v_started_at)) * 1000)::bigint);
    v_new_remaining := GREATEST(0, v_remaining_start - v_elapsed);
    v_overrun := v_elapsed > (v_remaining_start + v_grace);

    IF v_current_remaining IS NOT NULL THEN
      v_new_remaining := LEAST(v_new_remaining, v_current_remaining);
    END IF;

    -- Always roll-debit remaining_ms so it stays monotonic and truthful
    -- even if pause / disconnect / reaper miss. Existing UI reads from
    -- expires_at for the live countdown, so this doesn't affect display.
    UPDATE public.api_keys
       SET remaining_ms = v_new_remaining,
           is_active = CASE WHEN v_new_remaining <= 0 THEN false ELSE is_active END,
           active_session_id = CASE WHEN v_new_remaining <= 0 THEN NULL ELSE active_session_id END,
           active_session_started_at = CASE WHEN v_new_remaining <= 0 THEN NULL ELSE active_session_started_at END,
           expires_at = CASE WHEN v_new_remaining <= 0 THEN NULL ELSE expires_at END,
           last_session_ended_at = CASE WHEN v_new_remaining <= 0 THEN now() ELSE last_session_ended_at END
     WHERE id = v_key_id
       AND user_id = v_uid;

    IF v_new_remaining <= 0 THEN
      v_bill := GREATEST(LEAST(v_elapsed, v_remaining_start), LEAST(v_min_bill, v_remaining_start));
      UPDATE public.studio_sessions AS s
         SET ended_at = now(),
             end_reason = CASE WHEN v_overrun THEN 'exhausted_overrun' ELSE 'exhausted' END,
             remaining_ms_at_end = 0,
             duration_ms = v_bill
       WHERE s.session_id = p_session_id
         AND s.api_key_id = v_key_id
         AND s.user_id = v_uid
         AND s.ended_at IS NULL;
      RETURN false;
    END IF;
  END IF;

  RETURN true;
END;
$function$;

-- ---------- C. reap_stale_provider_credential_locks: default live window from config ----------
CREATE OR REPLACE FUNCTION public.reap_stale_provider_credential_locks(p_decart_key text, p_current_api_key_id uuid, p_live_window_ms integer DEFAULT NULL)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  r RECORD;
  v_min_bill bigint;
  v_live_ms integer;
  v_live_interval interval;
  v_elapsed bigint;
  v_bill bigint;
  v_remaining bigint;
BEGIN
  IF p_decart_key IS NULL OR length(trim(p_decart_key)) = 0 THEN
    RETURN 'ok';
  END IF;

  SELECT COALESCE(handshake_floor_ms, 8000), COALESCE(reap_stale_ms, 8000)
    INTO v_min_bill, v_live_ms
    FROM public.studio_pricing_config
   LIMIT 1;
  IF v_min_bill IS NULL THEN v_min_bill := 8000; END IF;
  IF v_live_ms IS NULL THEN v_live_ms := 8000; END IF;

  v_live_interval := make_interval(secs => GREATEST(COALESCE(p_live_window_ms, v_live_ms), 1000)::double precision / 1000.0);

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

-- ---------- D. mint_studio_credentials: live window from config ----------
CREATE OR REPLACE FUNCTION public.mint_studio_credentials(p_key text)
 RETURNS TABLE(ok boolean, reason text, decart_key text, remaining_ms bigint, label text, is_trial boolean, session_id text, expires_at timestamp with time zone)
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
  v_live_ms bigint;
  v_live_interval interval;
  v_provider_state text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN QUERY SELECT false, 'not_authenticated'::text, NULL::text, NULL::bigint, NULL::text, false, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT COALESCE(handshake_floor_ms, 8000), COALESCE(reap_stale_ms, 8000)
    INTO v_min_bill, v_live_ms
    FROM public.studio_pricing_config LIMIT 1;
  IF v_min_bill IS NULL THEN v_min_bill := 8000; END IF;
  IF v_live_ms IS NULL THEN v_live_ms := 8000; END IF;
  v_live_interval := make_interval(secs => GREATEST(v_live_ms, 1000)::double precision / 1000.0);

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
      IF v_prior.last_heartbeat_at > now() - v_live_interval THEN
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

-- ---------- E. start_studio_session: live window from config ----------
CREATE OR REPLACE FUNCTION public.start_studio_session(p_key text)
 RETURNS TABLE(ok boolean, reason text, session_id text, expires_at timestamp with time zone, remaining_ms bigint, label text, is_trial boolean)
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
  v_live_ms bigint;
  v_live_interval interval;
  v_prior_elapsed bigint;
  v_prior_bill bigint;
  v_prior_new_remaining bigint;
  v_provider_state text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN QUERY SELECT false, 'not_authenticated'::text, NULL::text, NULL::timestamptz, NULL::bigint, NULL::text, false;
    RETURN;
  END IF;

  SELECT COALESCE(handshake_floor_ms, 8000), COALESCE(reap_stale_ms, 8000)
    INTO v_min_bill, v_live_ms
    FROM public.studio_pricing_config LIMIT 1;
  IF v_min_bill IS NULL THEN v_min_bill := 8000; END IF;
  IF v_live_ms IS NULL THEN v_live_ms := 8000; END IF;
  v_live_interval := make_interval(secs => GREATEST(v_live_ms, 1000)::double precision / 1000.0);

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

    IF FOUND AND v_prior.last_heartbeat_at > now() - v_live_interval THEN
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

-- ---------- F. Reaper cadence: 5s -> 2s ----------
DO $$
DECLARE
  v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'reap-orphaned-studio-sessions';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;
  PERFORM cron.schedule(
    'reap-orphaned-studio-sessions',
    '2 seconds',
    $cron$SELECT public.reap_orphaned_studio_sessions();$cron$
  );
END $$;
