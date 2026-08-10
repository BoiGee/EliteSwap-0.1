
-- Round 6b: Kill remaining Decart burn leakage.
-- 1) Add warmup_grace_ms to pricing config (default 30s).
-- 2) Add first_heartbeat_at to studio_sessions.
-- 3) Fix reaper: grace window for active_session mismatch; smart bill floor.
-- 4) Heartbeat: stamp first_heartbeat_at on first successful tick.
-- 5) mint/start takeover: bill AT LEAST warmup_grace_ms when prior session had SDK activity.

ALTER TABLE public.studio_pricing_config
  ADD COLUMN IF NOT EXISTS warmup_grace_ms bigint NOT NULL DEFAULT 30000;

ALTER TABLE public.studio_sessions
  ADD COLUMN IF NOT EXISTS first_heartbeat_at timestamptz;

-- ---------------------------------------------------------------
-- heartbeat_studio_session: stamp first_heartbeat_at on first tick
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.heartbeat_studio_session(p_key text, p_session_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_key_id uuid;
  v_current_remaining bigint;
  v_started_at timestamptz;
  v_remaining_start bigint;
  v_min_bill bigint;
  v_new_remaining bigint;
  v_elapsed_total bigint;
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

  SELECT COALESCE(handshake_floor_ms, 8000) INTO v_min_bill
    FROM public.studio_pricing_config LIMIT 1;
  IF v_min_bill IS NULL THEN v_min_bill := 8000; END IF;

  PERFORM set_config('app.bypass_key_guard', 'on', true);

  UPDATE public.studio_sessions AS s
     SET last_heartbeat_at = now(),
         last_debit_at = now(),
         first_heartbeat_at = COALESCE(s.first_heartbeat_at, now())
   WHERE s.session_id = p_session_id
     AND s.api_key_id = v_key_id
     AND s.user_id = v_uid
     AND s.ended_at IS NULL
   RETURNING s.started_at,
             s.remaining_ms_at_start,
             COALESCE(s.min_bill_ms, v_min_bill)
     INTO v_started_at, v_remaining_start, v_min_bill;

  IF v_started_at IS NULL THEN
    RETURN false;
  END IF;

  v_elapsed_total := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - v_started_at)) * 1000)::bigint);

  IF v_remaining_start IS NOT NULL THEN
    v_new_remaining := GREATEST(0, v_remaining_start - v_elapsed_total);
    IF v_current_remaining IS NOT NULL THEN
      v_new_remaining := LEAST(v_new_remaining, v_current_remaining);
    END IF;

    UPDATE public.api_keys
       SET remaining_ms = v_new_remaining,
           expires_at = CASE WHEN v_new_remaining <= 0 THEN NULL
                             ELSE now() + (v_new_remaining || ' milliseconds')::interval END,
           is_active = CASE WHEN v_new_remaining <= 0 THEN false ELSE is_active END,
           active_session_id = CASE WHEN v_new_remaining <= 0 THEN NULL ELSE active_session_id END,
           active_session_started_at = CASE WHEN v_new_remaining <= 0 THEN NULL ELSE active_session_started_at END,
           last_session_ended_at = CASE WHEN v_new_remaining <= 0 THEN now() ELSE last_session_ended_at END
     WHERE id = v_key_id
       AND user_id = v_uid;

    IF v_new_remaining <= 0 THEN
      v_bill := LEAST(GREATEST(v_elapsed_total, v_min_bill), v_remaining_start);
      UPDATE public.studio_sessions AS s
         SET ended_at = now(),
             end_reason = 'exhausted',
             remaining_ms_at_end = 0,
             duration_ms = v_bill,
             last_debit_at = now()
       WHERE s.session_id = p_session_id
         AND s.api_key_id = v_key_id
         AND s.user_id = v_uid
         AND s.ended_at IS NULL;
      RETURN false;
    END IF;
  END IF;

  RETURN true;
END;
$$;

-- ---------------------------------------------------------------
-- reap_orphaned_studio_sessions: grace window + smart bill floor
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reap_orphaned_studio_sessions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
  r RECORD;
  v_delta bigint;
  v_end_ts timestamptz;
  v_duration bigint;
  v_new_key_remaining bigint;
  v_min_bill bigint;
  v_hard_stale_ms bigint;
  v_hard_stale_interval interval;
  v_warmup_ms bigint;
  v_warmup_interval interval;
  v_close boolean;
  v_reason text;
  v_effective_remaining bigint;
  v_session_age_ms bigint;
  v_bill_floor bigint;
BEGIN
  IF NOT pg_try_advisory_lock(hashtext('reap_studio_sessions')) THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(handshake_floor_ms, 8000),
         COALESCE(hard_stale_ms, 90000),
         COALESCE(warmup_grace_ms, 30000)
    INTO v_min_bill, v_hard_stale_ms, v_warmup_ms
    FROM public.studio_pricing_config LIMIT 1;
  IF v_min_bill IS NULL THEN v_min_bill := 8000; END IF;
  IF v_hard_stale_ms IS NULL THEN v_hard_stale_ms := 90000; END IF;
  IF v_warmup_ms IS NULL THEN v_warmup_ms := 30000; END IF;
  v_hard_stale_interval := make_interval(secs => v_hard_stale_ms::double precision / 1000.0);
  v_warmup_interval := make_interval(secs => v_warmup_ms::double precision / 1000.0);

  PERFORM set_config('app.bypass_key_guard', 'on', true);

  FOR r IN
    SELECT s.*,
           k.expires_at AS key_expires_at,
           k.remaining_ms AS key_remaining_ms,
           k.active_session_id AS key_active_session,
           k.user_id AS key_user_id
    FROM public.studio_sessions s
    LEFT JOIN public.api_keys k ON k.id = s.api_key_id
    WHERE s.ended_at IS NULL
  LOOP
    v_session_age_ms := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - r.started_at)) * 1000)::bigint);
    v_delta := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - COALESCE(r.last_debit_at, r.started_at))) * 1000)::bigint);
    v_effective_remaining := r.key_remaining_ms;

    IF r.remaining_ms_at_start IS NULL AND r.key_remaining_ms IS NULL THEN
      v_new_key_remaining := NULL;
    ELSE
      IF v_effective_remaining IS NULL THEN
        v_new_key_remaining := GREATEST(0, COALESCE(r.remaining_ms_at_start, 0) - v_delta);
      ELSE
        v_new_key_remaining := GREATEST(0, v_effective_remaining - v_delta);
      END IF;
    END IF;

    v_close := false;
    v_reason := NULL;

    IF r.key_expires_at IS NOT NULL AND r.key_expires_at <= now() THEN
      v_close := true;
      v_reason := 'expired';
    ELSIF r.key_user_id IS DISTINCT FROM r.user_id THEN
      v_close := true;
      v_reason := 'ownership_mismatch_reap';
    ELSIF r.key_active_session IS DISTINCT FROM r.session_id THEN
      -- GRACE: only fire this branch if the session is older than warmup_grace_ms.
      -- Below the grace window, a mismatch is almost certainly a mint/reconnect race —
      -- leave the row live so heartbeats can still land.
      IF v_session_age_ms >= v_warmup_ms THEN
        v_close := true;
        v_reason := 'orphaned_auto';
      END IF;
    ELSIF v_new_key_remaining IS NOT NULL AND v_new_key_remaining <= 0 THEN
      v_close := true;
      v_reason := 'exhausted';
    ELSIF r.last_heartbeat_at < now() - v_hard_stale_interval THEN
      v_close := true;
      v_reason := 'orphaned_auto';
    END IF;

    v_end_ts := now();
    IF v_close AND r.key_expires_at IS NOT NULL AND r.key_expires_at < v_end_ts AND v_reason = 'expired' THEN
      v_end_ts := r.key_expires_at;
    END IF;

    v_duration := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (v_end_ts - r.started_at)) * 1000)::bigint);

    IF v_close THEN
      -- Smart bill floor:
      --   * SDK never connected (no first_heartbeat_at) AND session younger than warmup
      --     → charge only handshake_floor_ms (the true "connect fizzle" case)
      --   * Otherwise → charge at least warmup_grace_ms (SDK burned real Decart time
      --     even if client heartbeats never landed)
      IF r.first_heartbeat_at IS NULL AND v_session_age_ms < v_warmup_ms THEN
        v_bill_floor := v_min_bill;
      ELSE
        v_bill_floor := GREATEST(v_min_bill, v_warmup_ms);
      END IF;

      v_duration := GREATEST(v_duration, v_bill_floor);
      IF r.remaining_ms_at_start IS NOT NULL THEN
        v_duration := LEAST(v_duration, r.remaining_ms_at_start);
      END IF;

      UPDATE public.studio_sessions AS s
         SET ended_at = v_end_ts,
             end_reason = v_reason,
             remaining_ms_at_end = CASE
               WHEN r.remaining_ms_at_start IS NOT NULL THEN GREATEST(0, r.remaining_ms_at_start - v_duration)
               ELSE v_new_key_remaining
             END,
             duration_ms = v_duration,
             last_debit_at = v_end_ts
       WHERE s.id = r.id
         AND s.ended_at IS NULL;
    ELSE
      UPDATE public.studio_sessions AS s
         SET last_debit_at = now()
       WHERE s.id = r.id
         AND s.ended_at IS NULL;
    END IF;

    IF r.key_active_session = r.session_id AND r.key_user_id = r.user_id THEN
      IF v_close THEN
        -- On close, apply the ACTUAL billed duration (not raw delta) to remaining_ms
        -- so the floor charge lands on the key.
        DECLARE v_final_remaining bigint;
        BEGIN
          IF r.remaining_ms_at_start IS NOT NULL THEN
            v_final_remaining := GREATEST(0, r.remaining_ms_at_start - v_duration);
          ELSE
            v_final_remaining := v_new_key_remaining;
          END IF;

          UPDATE public.api_keys
             SET active_session_id = NULL,
                 active_session_started_at = NULL,
                 last_session_ended_at = now(),
                 remaining_ms = CASE
                   WHEN v_final_remaining IS NULL THEN remaining_ms
                   WHEN remaining_ms IS NULL THEN v_final_remaining
                   ELSE LEAST(remaining_ms, v_final_remaining)
                 END,
                 expires_at = NULL,
                 is_active = CASE WHEN v_final_remaining IS NOT NULL AND v_final_remaining <= 0 THEN false ELSE is_active END
           WHERE id = r.api_key_id
             AND user_id = r.user_id;
        END;
      ELSE
        UPDATE public.api_keys
           SET remaining_ms = CASE
                 WHEN v_new_key_remaining IS NULL THEN remaining_ms
                 WHEN remaining_ms IS NULL THEN v_new_key_remaining
                 ELSE LEAST(remaining_ms, v_new_key_remaining)
               END,
               expires_at = CASE
                 WHEN v_new_key_remaining IS NULL THEN expires_at
                 ELSE now() + (v_new_key_remaining || ' milliseconds')::interval
               END
         WHERE id = r.api_key_id
           AND user_id = r.user_id;
      END IF;
    END IF;

    v_count := v_count + 1;
  END LOOP;

  PERFORM pg_advisory_unlock(hashtext('reap_studio_sessions'));
  RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------
-- mint_studio_credentials: takeover floor = warmup_grace_ms when prior had SDK activity
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mint_studio_credentials(p_key text)
RETURNS TABLE(ok boolean, reason text, decart_key text, remaining_ms bigint, label text, is_trial boolean, session_id text, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  v_provider_state text;
  v_prior_floor bigint;
BEGIN
  IF v_uid IS NULL THEN
    RETURN QUERY SELECT false, 'not_authenticated'::text, NULL::text, NULL::bigint, NULL::text, false, NULL::text, NULL::timestamptz;
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
        RETURN QUERY SELECT false, 'already_active_elsewhere'::text, NULL::text, v_row.remaining_ms, v_row.label, v_is_trial, NULL::text, NULL::timestamptz;
        RETURN;
      END IF;

      PERFORM set_config('app.bypass_key_guard', 'on', true);
      v_prior_elapsed := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - v_prior.started_at)) * 1000)::bigint);
      -- Floor: handshake if SDK never fired a heartbeat AND session was young; else warmup.
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
$$;

-- ---------------------------------------------------------------
-- start_studio_session: same takeover floor logic
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_studio_session(p_key text)
RETURNS TABLE(ok boolean, reason text, session_id text, expires_at timestamptz, remaining_ms bigint, label text, is_trial boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  v_provider_state text;
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
$$;
