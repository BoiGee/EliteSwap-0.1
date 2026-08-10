-- Move from per-user Decart key assignment (api_key_pool, one real key
-- permanently bound to each paying user forever) to a small shared pool,
-- assigned fresh per-session. Confirmed with the user that Decart's plan
-- supports multiple concurrent connections per key, so the old
-- reap_stale_provider_credential_locks() exclusivity lock (one live
-- session per decart_key, enforced via advisory lock + busy-check) is no
-- longer needed — that function is left in place but becomes unused by
-- both callers below; harmless dead code, not dropped in case anything
-- else ever needs the pattern.
--
-- User-facing access keys (api_keys.key, what a user pastes into the
-- studio login) are UNCHANGED — no disruption to any of the 1810 existing
-- users. Only the server-side resolution of the real Decart credential
-- changes: instead of a 1:1 permanent mapping, api_key_secrets.decart_key
-- gets refreshed on every mint from the shared pool. remaining_ms,
-- expires_at, session history — all untouched, all keyed by api_key_id /
-- user_id, independent of which Decart credential backs a given session.
--
-- NOT included here (deliberately — real secrets don't belong in git
-- history): seeding decart_shared_pool with actual Decart key values.
-- After applying this migration, seed manually, e.g.:
--   INSERT INTO public.decart_shared_pool (decart_key, note)
--   VALUES ('<real key>', 'seed note');
-- As of the 2026-08-10 migration, seeded with 2 keys pulled from the
-- then-existing api_key_pool spares (rows retired to status='disabled'
-- there, noted as "now serving as shared decart_shared_pool key").

CREATE TABLE IF NOT EXISTS public.decart_shared_pool (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  decart_key text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT decart_shared_pool_pkey PRIMARY KEY (id)
);

ALTER TABLE public.decart_shared_pool ENABLE ROW LEVEL SECURITY;

-- Mirrors api_key_secrets' access pattern exactly (verified against the
-- live table): RLS enabled, only service_role has an applicable policy,
-- so authenticated/anon get zero rows despite broad default table grants.
DROP POLICY IF EXISTS "service role manages shared pool" ON public.decart_shared_pool;
CREATE POLICY "service role manages shared pool"
  ON public.decart_shared_pool FOR ALL
  TO service_role
  USING (true);

-- Admins can view/manage directly too (matches studio_pricing_config's
-- admin-management pattern) for whenever a UI gets built for this.
DROP POLICY IF EXISTS "Admins manage shared decart pool" ON public.decart_shared_pool;
CREATE POLICY "Admins manage shared decart pool"
  ON public.decart_shared_pool FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

-- Random selection over the active pool — self-balancing across many
-- mints without needing to track last-used state. NULL if the pool is
-- ever emptied (both callers below treat that as a hard failure, not a
-- silent fallback to something insecure).
CREATE OR REPLACE FUNCTION public.assign_shared_decart_key()
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT decart_key FROM public.decart_shared_pool
   WHERE is_active = true
   ORDER BY random()
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.assign_shared_decart_key() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_shared_decart_key() TO authenticated, service_role;

-- ---------------------------------------------------------------
-- mint_studio_credentials: shared-pool resolution, no more per-key lock
-- ---------------------------------------------------------------
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
             OR COALESCE(v_row.label, '') ILIKE 'trial%'
             OR v_row.pool_key_id IS NOT NULL;
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

-- ---------------------------------------------------------------
-- start_studio_session: same shared-pool resolution. Note: not called
-- from the frontend today (verified — only mint_studio_credentials is
-- used by DeepfakeStudio.tsx), and its own RETURNS TABLE doesn't even
-- include decart_key, so v_secret only ever existed to feed the old
-- lock check. Kept in sync anyway rather than left half-consistent.
-- ---------------------------------------------------------------
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
