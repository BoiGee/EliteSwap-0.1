-- Support report (emilmary736@gmail.com, 2026-09-01): an active paid
-- ("Basic") key was showing the "Free trial ended — Upgrade Now" screen
-- instead of studio access, even though the key was active and not a trial.
--
-- Root cause: mint_studio_credentials() (and its sibling start_studio_
-- session(), plus admin_time_ledger()'s copy of the same check) classify a
-- key as trial via:
--   label ILIKE 'free trial%' OR label ILIKE 'trial%' OR pool_key_id IS NOT NULL
--
-- The pool_key_id clause is a false-positive generator for historical rows.
-- 20260810154244_issue_api_key_no_pool.sql already documented this: "pool_
-- key_id IS NOT NULL already doesn't cleanly separate trial vs paid in the
-- real data (both cohorts are mixed)" — paid keys issued before that fix
-- can carry a stray non-null pool_key_id. Any such key gets mislabeled as
-- trial, and once its balance hits 0 (or dips under the 30s trial-only
-- floor), the user is wrongly told their *trial* ended instead of that
-- their paid key ran out.
--
-- issue_api_key_for_payment() (the only paid-key issuance path) always sets
-- pool_key_id to NULL and never gives a key a label matching 'trial%', so
-- the label check alone is sufficient and doesn't reintroduce the
-- misclassification for genuine trial keys (assign_trial_key_from_purchase
-- always labels those 'Trial Key').

CREATE OR REPLACE FUNCTION public.mint_studio_credentials(p_key text)
 RETURNS TABLE(ok boolean, reason text, decart_key text, remaining_ms bigint, label text, is_trial boolean, session_id text, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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
  v_warmup_ms bigint;
  v_prior_floor bigint;
  v_rate_limit int;
  v_attempts int;
  v_window_start timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RETURN QUERY SELECT false, 'not_authenticated'::text, NULL::text, NULL::bigint, NULL::text, false, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT COALESCE(handshake_floor_ms, 8000), COALESCE(reap_stale_ms, 8000), COALESCE(warmup_grace_ms, 30000), COALESCE(mint_rate_limit_per_min, 6)
    INTO v_min_bill, v_live_ms, v_warmup_ms, v_rate_limit
    FROM public.studio_pricing_config LIMIT 1;
  IF v_min_bill IS NULL THEN v_min_bill := 8000; END IF;
  IF v_live_ms IS NULL THEN v_live_ms := 8000; END IF;
  IF v_warmup_ms IS NULL THEN v_warmup_ms := 30000; END IF;
  IF v_rate_limit IS NULL OR v_rate_limit <= 0 THEN v_rate_limit := 6; END IF;
  v_live_interval := make_interval(secs => GREATEST(v_live_ms, 1000)::double precision / 1000.0);

  SELECT * INTO v_row
    FROM public.api_keys
   WHERE key = trim(p_key) AND user_id = v_uid
   ORDER BY is_active DESC, created_at DESC
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    SELECT EXISTS(SELECT 1 FROM public.api_keys WHERE key = trim(p_key)) INTO v_foreign_exists;
    BEGIN
      INSERT INTO public.studio_credential_mints(user_id, api_key_id, key_label, ok, reason)
      VALUES (v_uid, NULL, NULL, false, CASE WHEN v_foreign_exists THEN 'not_owner' ELSE 'key_not_found' END);
    EXCEPTION WHEN OTHERS THEN NULL; END;
    IF v_foreign_exists THEN
      RETURN QUERY SELECT false, 'not_owner'::text, NULL::text, NULL::bigint, NULL::text, false, NULL::text, NULL::timestamptz;
    ELSE
      RETURN QUERY SELECT false, 'key_not_found'::text, NULL::text, NULL::bigint, NULL::text, false, NULL::text, NULL::timestamptz;
    END IF;
    RETURN;
  END IF;

  v_window_start := v_row.mint_attempts_window_start;
  v_attempts := COALESCE(v_row.mint_attempts_in_window, 0);
  IF v_window_start IS NULL OR v_window_start < now() - interval '60 seconds' THEN
    v_window_start := now();
    v_attempts := 0;
  END IF;
  IF v_attempts >= v_rate_limit THEN
    PERFORM set_config('app.bypass_key_guard', 'on', true);
    UPDATE public.api_keys
       SET mint_attempts_window_start = v_window_start,
           mint_attempts_in_window = v_attempts
     WHERE id = v_row.id;
    BEGIN
      INSERT INTO public.studio_credential_mints(user_id, api_key_id, key_label, ok, reason)
      VALUES (v_uid, v_row.id, v_row.label, false, 'too_many_attempts');
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RETURN QUERY SELECT false, 'too_many_attempts'::text, NULL::text, v_row.remaining_ms, v_row.label, false, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;
  PERFORM set_config('app.bypass_key_guard', 'on', true);
  UPDATE public.api_keys
     SET mint_attempts_window_start = v_window_start,
         mint_attempts_in_window = v_attempts + 1
   WHERE id = v_row.id;

  v_is_trial := COALESCE(v_row.label, '') ILIKE 'free trial%'
             OR COALESCE(v_row.label, '') ILIKE 'trial%';
  v_expired := v_row.expires_at IS NOT NULL AND v_row.expires_at <= now();
  v_trial_exhausted := v_is_trial AND v_row.remaining_ms IS NOT NULL AND v_row.remaining_ms <= 0;

  IF NOT v_row.is_active OR (v_is_trial AND v_expired) OR v_trial_exhausted THEN
    BEGIN
      INSERT INTO public.studio_credential_mints(user_id, api_key_id, key_label, ok, reason)
      VALUES (v_uid, v_row.id, v_row.label, false, 'expired_or_inactive');
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RETURN QUERY SELECT false, 'expired_or_inactive'::text, NULL::text, v_row.remaining_ms, v_row.label, v_is_trial, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_is_trial AND v_row.remaining_ms IS NOT NULL AND v_row.remaining_ms < 30000 THEN
    BEGIN
      INSERT INTO public.studio_credential_mints(user_id, api_key_id, key_label, ok, reason)
      VALUES (v_uid, v_row.id, v_row.label, false, 'trial_time_too_low');
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RETURN QUERY SELECT false, 'trial_time_too_low'::text, NULL::text, v_row.remaining_ms, v_row.label, v_is_trial, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_row.active_session_id IS NOT NULL THEN
    SELECT s.session_id AS prior_session_id,
           s.started_at AS started_at,
           s.last_heartbeat_at AS last_heartbeat_at,
           s.first_heartbeat_at AS first_heartbeat_at,
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
        BEGIN
          INSERT INTO public.studio_credential_mints(user_id, api_key_id, key_label, ok, reason)
          VALUES (v_uid, v_row.id, v_row.label, false, 'already_active_elsewhere');
        EXCEPTION WHEN OTHERS THEN NULL; END;
        RETURN QUERY SELECT false, 'already_active_elsewhere'::text, NULL::text, v_row.remaining_ms, v_row.label, v_is_trial, NULL::text, NULL::timestamptz;
        RETURN;
      END IF;

      PERFORM set_config('app.bypass_key_guard', 'on', true);
      v_prior_elapsed := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - v_prior.started_at)) * 1000)::bigint);
      IF v_prior.first_heartbeat_at IS NULL AND v_prior_elapsed < v_warmup_ms THEN
        v_prior_floor := v_prior.min_bill;
      ELSE
        v_prior_floor := GREATEST(v_prior.min_bill, v_warmup_ms);
      END IF;
      v_prior_bill := GREATEST(v_prior_elapsed, v_prior_floor);
      IF v_prior.rem_start IS NOT NULL THEN
        v_prior_bill := LEAST(v_prior_bill, v_prior.rem_start);
        v_prior_new_remaining := GREATEST(0, v_prior.rem_start - v_prior_bill);
      ELSE
        v_prior_new_remaining := GREATEST(0, COALESCE(v_row.remaining_ms, 0) - v_prior_bill);
      END IF;

      UPDATE public.studio_sessions
         SET ended_at = now(),
             end_reason = 'superseded_by_new_mint',
             remaining_ms_at_end = v_prior_new_remaining,
             duration_ms = v_prior_bill,
             last_debit_at = now()
       WHERE session_id = v_prior.prior_session_id
         AND ended_at IS NULL;

      UPDATE public.api_keys
         SET remaining_ms = CASE
               WHEN v_prior_new_remaining IS NULL THEN remaining_ms
               ELSE LEAST(COALESCE(remaining_ms, v_prior_new_remaining), v_prior_new_remaining)
             END,
             active_session_id = NULL,
             active_session_started_at = NULL,
             expires_at = NULL
       WHERE id = v_row.id
         AND user_id = v_uid;

      SELECT * INTO v_row FROM public.api_keys WHERE id = v_row.id AND user_id = v_uid FOR UPDATE;
      IF v_row.remaining_ms IS NOT NULL AND v_row.remaining_ms <= 0 THEN
        UPDATE public.api_keys SET is_active = false WHERE id = v_row.id AND user_id = v_uid;
        BEGIN
          INSERT INTO public.studio_credential_mints(user_id, api_key_id, key_label, ok, reason)
          VALUES (v_uid, v_row.id, v_row.label, false, 'expired_or_inactive');
        EXCEPTION WHEN OTHERS THEN NULL; END;
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

  -- Shared-pool resolution replaces the old per-user api_key_secrets
  -- lookup + reap_stale_provider_credential_locks exclusivity check.
  SELECT public.assign_shared_decart_key() INTO v_secret;
  IF v_secret IS NULL THEN
    BEGIN
      INSERT INTO public.studio_credential_mints(user_id, api_key_id, key_label, ok, reason)
      VALUES (v_uid, v_row.id, v_row.label, false, 'no_shared_key_available');
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RETURN QUERY SELECT false, 'no_shared_key_available'::text, NULL::text, v_row.remaining_ms, v_row.label, v_is_trial, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  PERFORM set_config('app.bypass_key_guard', 'on', true);
  INSERT INTO public.api_key_secrets(api_key_id, decart_key)
  VALUES (v_row.id, v_secret)
  ON CONFLICT (api_key_id) DO UPDATE SET decart_key = EXCLUDED.decart_key, updated_at = now();

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
    BEGIN
      INSERT INTO public.studio_credential_mints(user_id, api_key_id, key_label, ok, reason)
      VALUES (v_uid, v_row.id, v_row.label, false, 'session_open_failed');
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RETURN QUERY SELECT false, 'session_open_failed'::text, NULL::text, v_row.remaining_ms, v_row.label, v_is_trial, NULL::text, NULL::timestamptz;
    RETURN;
  END;

  BEGIN
    PERFORM public.record_studio_connect_attempt(v_row.key);
  EXCEPTION WHEN OTHERS THEN NULL; END;

  BEGIN
    INSERT INTO public.studio_credential_mints(
      user_id, api_key_id, key_label, expires_at,
      ok, reason, linked_session_id, settled_at
    ) VALUES (
      v_uid, v_row.id, v_row.label, v_expires_at,
      true, NULL, v_new_session, now()
    );
  EXCEPTION WHEN OTHERS THEN NULL; END;

  RETURN QUERY SELECT true, NULL::text, v_secret, v_row.remaining_ms, v_row.label, v_is_trial, v_new_session, v_expires_at;
END;
$function$;

-- start_studio_session: not called from the frontend today (per the
-- 20260810154243 comment), but kept in sync with the same fix so it doesn't
-- become a landmine if it's ever wired back up.
CREATE OR REPLACE FUNCTION public.start_studio_session(p_key text)
 RETURNS TABLE(ok boolean, reason text, session_id text, expires_at timestamp with time zone, remaining_ms bigint, label text, is_trial boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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
  v_warmup_ms bigint;
  v_prior_elapsed bigint;
  v_prior_bill bigint;
  v_prior_new_remaining bigint;
  v_prior_floor bigint;
BEGIN
  IF v_uid IS NULL THEN
    RETURN QUERY SELECT false, 'not_authenticated'::text, NULL::text, NULL::timestamptz, NULL::bigint, NULL::text, false;
    RETURN;
  END IF;

  SELECT COALESCE(handshake_floor_ms, 8000), COALESCE(reap_stale_ms, 8000), COALESCE(warmup_grace_ms, 30000)
    INTO v_min_bill, v_live_ms, v_warmup_ms
    FROM public.studio_pricing_config LIMIT 1;
  IF v_min_bill IS NULL THEN v_min_bill := 8000; END IF;
  IF v_live_ms IS NULL THEN v_live_ms := 8000; END IF;
  IF v_warmup_ms IS NULL THEN v_warmup_ms := 30000; END IF;
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
             OR COALESCE(v_row.label, '') ILIKE 'trial%';
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
           s.first_heartbeat_at AS first_heartbeat_at,
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
      IF v_prior.first_heartbeat_at IS NULL AND v_prior_elapsed < v_warmup_ms THEN
        v_prior_floor := v_prior.min_bill;
      ELSE
        v_prior_floor := GREATEST(v_prior.min_bill, v_warmup_ms);
      END IF;
      v_prior_bill := GREATEST(v_prior_elapsed, v_prior_floor);
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

  SELECT public.assign_shared_decart_key() INTO v_secret;
  IF v_secret IS NULL THEN
    RETURN QUERY SELECT false, 'no_shared_key_available'::text, NULL::text, NULL::timestamptz, v_row.remaining_ms, v_row.label, v_is_trial;
    RETURN;
  END IF;

  PERFORM set_config('app.bypass_key_guard', 'on', true);
  INSERT INTO public.api_key_secrets(api_key_id, decart_key)
  VALUES (v_row.id, v_secret)
  ON CONFLICT (api_key_id) DO UPDATE SET decart_key = EXCLUDED.decart_key, updated_at = now();

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

-- check_studio_session: not called from the frontend today either
-- (verified — no reference outside the generated types.ts), same fix for
-- the same reason as start_studio_session above.
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
             OR COALESCE(v_row.label, '') ILIKE 'trial%';
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

-- admin_time_ledger: same false-positive signal in its key_type CASE.
CREATE OR REPLACE FUNCTION public.admin_time_ledger()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cps numeric;
  v_result jsonb;
  v_totals jsonb;
  v_users jsonb;
  v_keys jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT COALESCE(credits_per_second, 3.2) INTO v_cps
  FROM public.studio_pricing_config WHERE id = true LIMIT 1;
  IF v_cps IS NULL THEN v_cps := 3.2; END IF;

  WITH sess AS (
    SELECT
      api_key_id,
      SUM(COALESCE(duration_ms,0))::bigint AS used_ms,
      COUNT(*)::int AS sessions,
      MAX(COALESCE(ended_at, last_heartbeat_at, started_at)) AS last_session_at,
      bool_or(ended_at IS NULL AND last_heartbeat_at > now() - interval '20 seconds') AS is_live
    FROM public.studio_sessions
    GROUP BY api_key_id
  ),
  key_rows AS (
    SELECT
      k.id AS key_id,
      k.user_id,
      k.label,
      CASE
        WHEN COALESCE(k.label, '') ILIKE 'free trial%' OR COALESCE(k.label, '') ILIKE 'trial%'
          THEN 'trial'::text
        ELSE 'paid'::text
      END AS key_type,
      k.is_active,
      k.created_at,
      k.expires_at,
      COALESCE(k.remaining_ms, 0)::bigint AS remaining_ms,
      COALESCE(s.used_ms, 0)::bigint AS used_ms,
      (COALESCE(k.remaining_ms,0) + COALESCE(s.used_ms,0))::bigint AS allocated_ms,
      COALESCE(s.sessions, 0) AS sessions,
      s.last_session_at,
      COALESCE(s.is_live, false) AS is_live,
      p.email,
      p.display_name
    FROM public.api_keys k
    LEFT JOIN sess s ON s.api_key_id = k.id
    LEFT JOIN public.profiles p ON p.user_id = k.user_id
  )
  SELECT
    jsonb_build_object(
      'allocated_ms', COALESCE(SUM(allocated_ms) FILTER (WHERE true), 0),
      'used_ms',      COALESCE(SUM(used_ms), 0),
      'remaining_ms', COALESCE(SUM(remaining_ms), 0),
      'allocated_ms_paid',  COALESCE(SUM(allocated_ms) FILTER (WHERE key_type='paid'), 0),
      'used_ms_paid',       COALESCE(SUM(used_ms)      FILTER (WHERE key_type='paid'), 0),
      'remaining_ms_paid',  COALESCE(SUM(remaining_ms) FILTER (WHERE key_type='paid'), 0),
      'allocated_ms_trial', COALESCE(SUM(allocated_ms) FILTER (WHERE key_type='trial'), 0),
      'used_ms_trial',      COALESCE(SUM(used_ms)      FILTER (WHERE key_type='trial'), 0),
      'remaining_ms_trial', COALESCE(SUM(remaining_ms) FILTER (WHERE key_type='trial'), 0),
      'keys_total',    COUNT(*),
      'keys_active',   COUNT(*) FILTER (WHERE is_active),
      'keys_live',     COUNT(*) FILTER (WHERE is_live),
      'used_ms_24h',   COALESCE((SELECT SUM(COALESCE(duration_ms,0)) FROM public.studio_sessions WHERE COALESCE(ended_at, last_heartbeat_at, started_at) >= now() - interval '24 hours'), 0),
      'used_ms_7d',    COALESCE((SELECT SUM(COALESCE(duration_ms,0)) FROM public.studio_sessions WHERE COALESCE(ended_at, last_heartbeat_at, started_at) >= now() - interval '7 days'), 0)
    ),
    (
      SELECT COALESCE(jsonb_agg(u ORDER BY u->>'remaining_ms' DESC), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object(
          'user_id', user_id,
          'email', MAX(email),
          'display_name', MAX(display_name),
          'keys_count', COUNT(*),
          'allocated_ms', SUM(allocated_ms),
          'used_ms', SUM(used_ms),
          'remaining_ms', SUM(remaining_ms),
          'sessions', SUM(sessions),
          'last_session_at', MAX(last_session_at),
          'is_live', bool_or(is_live),
          'has_paid', bool_or(key_type='paid'),
          'has_trial', bool_or(key_type='trial')
        ) AS u
        FROM key_rows
        WHERE user_id IS NOT NULL
        GROUP BY user_id
      ) uu
    ),
    (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'key_id', key_id,
        'user_id', user_id,
        'email', email,
        'display_name', display_name,
        'label', label,
        'key_type', key_type,
        'is_active', is_active,
        'is_live', is_live,
        'created_at', created_at,
        'expires_at', expires_at,
        'allocated_ms', allocated_ms,
        'used_ms', used_ms,
        'remaining_ms', remaining_ms,
        'sessions', sessions,
        'last_session_at', last_session_at
      ) ORDER BY remaining_ms DESC), '[]'::jsonb)
      FROM key_rows
    )
  INTO v_totals, v_users, v_keys
  FROM key_rows;

  v_result := jsonb_build_object(
    'generated_at', now(),
    'credits_per_second', v_cps,
    'totals', COALESCE(v_totals, '{}'::jsonb),
    'users',  COALESCE(v_users,  '[]'::jsonb),
    'keys',   COALESCE(v_keys,   '[]'::jsonb)
  );

  RETURN v_result;
END;
$$;
