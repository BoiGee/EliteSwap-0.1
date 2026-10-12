-- Dual-provider realtime studio backend plumbing: lets an admin switch the
-- platform-wide active provider between Decart and Vidu S2 at any time,
-- without removing Decart. Mirrors the decart_shared_pool pattern
-- (supabase/migrations/20260810154243_shared_decart_pool.sql) for a new
-- vidu_shared_pool, and extends the existing mint_studio_credentials()
-- chokepoint to report which provider a mint resolved against.
--
-- Trust-model asymmetry (deliberate, not an inconsistency to fix here):
-- Decart's raw pooled key is handed straight to the browser today (the
-- @decartai/sdk connects with it directly). Vidu requires a server-to-server
-- call to mint a short-lived join credential -- the raw Vidu key must never
-- reach the browser. So when active_provider = 'vidu', this function only
-- confirms a pool key is available (so we don't open/bill a session against
-- an empty pool) and returns provider='vidu' with decart_key=NULL; the
-- browser then calls the new mint-vidu-rtc-session edge function, which
-- independently resolves a pooled Vidu key via a service-role client and
-- performs the real Vidu API call.

CREATE TABLE IF NOT EXISTS public.vidu_shared_pool (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  vidu_api_key text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vidu_shared_pool_pkey PRIMARY KEY (id)
);

ALTER TABLE public.vidu_shared_pool ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service role manages shared vidu pool" ON public.vidu_shared_pool;
CREATE POLICY "service role manages shared vidu pool"
  ON public.vidu_shared_pool FOR ALL
  TO service_role
  USING (true);

DROP POLICY IF EXISTS "Admins manage shared vidu pool" ON public.vidu_shared_pool;
CREATE POLICY "Admins manage shared vidu pool"
  ON public.vidu_shared_pool FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

CREATE OR REPLACE FUNCTION public.assign_shared_vidu_key()
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT vidu_api_key FROM public.vidu_shared_pool
   WHERE is_active = true
   ORDER BY random()
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.assign_shared_vidu_key() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_shared_vidu_key() TO authenticated, service_role;

ALTER TABLE public.studio_pricing_config
  ADD COLUMN IF NOT EXISTS active_provider text NOT NULL DEFAULT 'decart';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'studio_pricing_config_active_provider_check'
  ) THEN
    ALTER TABLE public.studio_pricing_config
      ADD CONSTRAINT studio_pricing_config_active_provider_check
      CHECK (active_provider IN ('decart', 'vidu'));
  END IF;
END $$;

-- Return-signature change (new trailing `provider` column) requires DROP
-- before CREATE; CREATE OR REPLACE alone can't alter a RETURNS TABLE shape.
DROP FUNCTION IF EXISTS public.mint_studio_credentials(text);

CREATE OR REPLACE FUNCTION public.mint_studio_credentials(p_key text)
 RETURNS TABLE(ok boolean, reason text, decart_key text, remaining_ms bigint, label text, is_trial boolean, session_id text, expires_at timestamp with time zone, message text, provider text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.api_keys%ROWTYPE;
  v_secret text;
  v_vidu_secret text;
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
  v_studio_locked boolean;
  v_lock_reason text;
  v_active_provider text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN QUERY SELECT false, 'not_authenticated'::text, NULL::text, NULL::bigint, NULL::text, false, NULL::text, NULL::timestamptz, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT COALESCE(handshake_floor_ms, 8000), COALESCE(reap_stale_ms, 8000), COALESCE(warmup_grace_ms, 30000), COALESCE(mint_rate_limit_per_min, 6), studio_locked, lock_reason, COALESCE(active_provider, 'decart')
    INTO v_min_bill, v_live_ms, v_warmup_ms, v_rate_limit, v_studio_locked, v_lock_reason, v_active_provider
    FROM public.studio_pricing_config LIMIT 1;
  IF v_min_bill IS NULL THEN v_min_bill := 8000; END IF;
  IF v_live_ms IS NULL THEN v_live_ms := 8000; END IF;
  IF v_warmup_ms IS NULL THEN v_warmup_ms := 30000; END IF;
  IF v_rate_limit IS NULL OR v_rate_limit <= 0 THEN v_rate_limit := 6; END IF;
  IF v_active_provider IS NULL THEN v_active_provider := 'decart'; END IF;
  v_live_interval := make_interval(secs => GREATEST(v_live_ms, 1000)::double precision / 1000.0);

  -- Platform-wide kill switch: blocks every connect attempt (trial and
  -- paid alike) before even looking up the key, so it can't be bypassed
  -- by key type or ownership state.
  IF COALESCE(v_studio_locked, false) THEN
    RETURN QUERY SELECT false, 'studio_locked'::text, NULL::text, NULL::bigint, NULL::text, false, NULL::text, NULL::timestamptz,
      COALESCE(NULLIF(trim(v_lock_reason), ''), 'The studio is temporarily unavailable. Please check back soon.'), v_active_provider;
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
    BEGIN
      INSERT INTO public.studio_credential_mints(user_id, api_key_id, key_label, ok, reason)
      VALUES (v_uid, NULL, NULL, false, CASE WHEN v_foreign_exists THEN 'not_owner' ELSE 'key_not_found' END);
    EXCEPTION WHEN OTHERS THEN NULL; END;
    IF v_foreign_exists THEN
      RETURN QUERY SELECT false, 'not_owner'::text, NULL::text, NULL::bigint, NULL::text, false, NULL::text, NULL::timestamptz, NULL::text, v_active_provider;
    ELSE
      RETURN QUERY SELECT false, 'key_not_found'::text, NULL::text, NULL::bigint, NULL::text, false, NULL::text, NULL::timestamptz, NULL::text, v_active_provider;
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
    RETURN QUERY SELECT false, 'too_many_attempts'::text, NULL::text, v_row.remaining_ms, v_row.label, false, NULL::text, NULL::timestamptz, NULL::text, v_active_provider;
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
    RETURN QUERY SELECT false, 'expired_or_inactive'::text, NULL::text, v_row.remaining_ms, v_row.label, v_is_trial, NULL::text, NULL::timestamptz, NULL::text, v_active_provider;
    RETURN;
  END IF;

  IF v_is_trial AND v_row.remaining_ms IS NOT NULL AND v_row.remaining_ms < 30000 THEN
    BEGIN
      INSERT INTO public.studio_credential_mints(user_id, api_key_id, key_label, ok, reason)
      VALUES (v_uid, v_row.id, v_row.label, false, 'trial_time_too_low');
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RETURN QUERY SELECT false, 'trial_time_too_low'::text, NULL::text, v_row.remaining_ms, v_row.label, v_is_trial, NULL::text, NULL::timestamptz, NULL::text, v_active_provider;
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
        RETURN QUERY SELECT false, 'already_active_elsewhere'::text, NULL::text, v_row.remaining_ms, v_row.label, v_is_trial, NULL::text, NULL::timestamptz, NULL::text, v_active_provider;
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
        RETURN QUERY SELECT false, 'expired_or_inactive'::text, NULL::text, v_row.remaining_ms, v_row.label, v_is_trial, NULL::text, NULL::timestamptz, NULL::text, v_active_provider;
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

  -- Provider resolution: Decart hands back its raw pooled key directly (the
  -- browser's @decartai/sdk connects with it). Vidu's trust model is
  -- tighter -- the raw pooled key stays server-side; mint-vidu-rtc-session
  -- (a new edge function) resolves its own pooled key independently and
  -- performs the real Vidu API call. Here we only confirm a Vidu key is
  -- available, so we never open/bill a session against an empty pool.
  IF v_active_provider = 'vidu' THEN
    SELECT public.assign_shared_vidu_key() INTO v_vidu_secret;
    IF v_vidu_secret IS NULL THEN
      BEGIN
        INSERT INTO public.studio_credential_mints(user_id, api_key_id, key_label, ok, reason)
        VALUES (v_uid, v_row.id, v_row.label, false, 'no_shared_key_available');
      EXCEPTION WHEN OTHERS THEN NULL; END;
      RETURN QUERY SELECT false, 'no_shared_key_available'::text, NULL::text, v_row.remaining_ms, v_row.label, v_is_trial, NULL::text, NULL::timestamptz, NULL::text, v_active_provider;
      RETURN;
    END IF;
  ELSE
    SELECT public.assign_shared_decart_key() INTO v_secret;
    IF v_secret IS NULL THEN
      BEGIN
        INSERT INTO public.studio_credential_mints(user_id, api_key_id, key_label, ok, reason)
        VALUES (v_uid, v_row.id, v_row.label, false, 'no_shared_key_available');
      EXCEPTION WHEN OTHERS THEN NULL; END;
      RETURN QUERY SELECT false, 'no_shared_key_available'::text, NULL::text, v_row.remaining_ms, v_row.label, v_is_trial, NULL::text, NULL::timestamptz, NULL::text, v_active_provider;
      RETURN;
    END IF;

    PERFORM set_config('app.bypass_key_guard', 'on', true);
    INSERT INTO public.api_key_secrets(api_key_id, decart_key)
    VALUES (v_row.id, v_secret)
    ON CONFLICT (api_key_id) DO UPDATE SET decart_key = EXCLUDED.decart_key, updated_at = now();
  END IF;

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
    RETURN QUERY SELECT false, 'session_open_failed'::text, NULL::text, v_row.remaining_ms, v_row.label, v_is_trial, NULL::text, NULL::timestamptz, NULL::text, v_active_provider;
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

  RETURN QUERY SELECT true, NULL::text, v_secret, v_row.remaining_ms, v_row.label, v_is_trial, v_new_session, v_expires_at, NULL::text, v_active_provider;
END;
$function$;

-- Admin-only toggle for the platform-wide active provider, modeled on
-- admin_set_studio_lock()'s pattern: audit-logged via the same
-- log_admin_action() helper used across the admin panel.
CREATE OR REPLACE FUNCTION public.admin_set_active_provider(p_provider text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_provider NOT IN ('decart', 'vidu') THEN
    RAISE EXCEPTION 'invalid provider' USING ERRCODE = '22023';
  END IF;

  SELECT jsonb_build_object('active_provider', active_provider)
    INTO v_before
    FROM public.studio_pricing_config WHERE id = true;

  UPDATE public.studio_pricing_config
     SET active_provider = p_provider,
         updated_at = now()
   WHERE id = true;

  v_after := jsonb_build_object('active_provider', p_provider);

  PERFORM public.log_admin_action('studio_provider_switch', 'studio_pricing_config', 'true', v_before, v_after, '{}'::jsonb);

  RETURN v_after;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_active_provider(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_active_provider(text) TO authenticated;

-- Audit helpers for the Vidu pool admin UI, mirroring
-- log_decart_shared_pool_reveal() / log_decart_shared_pool_status_change()
-- (supabase/migrations/20260810170000_decart_shared_pool_admin_ui.sql,
-- 20260815220000_decart_pool_status_change_audit.sql) exactly, swapped onto
-- vidu_shared_pool/vidu_api_key.
CREATE OR REPLACE FUNCTION public.log_vidu_shared_pool_reveal(p_pool_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_email text;
  v_row public.vidu_shared_pool%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.has_role(v_user, 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  SELECT * INTO v_row FROM public.vidu_shared_pool WHERE id = p_pool_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'pool_row_not_found'; END IF;

  SELECT email INTO v_email FROM public.profiles WHERE user_id = v_user;

  INSERT INTO public.admin_audit_logs (
    actor_id, actor_email, actor_role, action, target_type, target_id, metadata
  ) VALUES (
    v_user, v_email, 'admin', 'vidu_shared_pool_reveal', 'vidu_shared_pool', p_pool_id,
    jsonb_build_object('is_active', v_row.is_active, 'note', v_row.note)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.log_vidu_shared_pool_reveal(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_vidu_shared_pool_reveal(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.log_vidu_shared_pool_status_change(p_pool_id uuid, p_is_active boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_email text;
  v_row public.vidu_shared_pool%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.has_role(v_user, 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  SELECT * INTO v_row FROM public.vidu_shared_pool WHERE id = p_pool_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'pool_row_not_found'; END IF;

  SELECT email INTO v_email FROM public.profiles WHERE user_id = v_user;

  INSERT INTO public.admin_audit_logs (
    actor_id, actor_email, actor_role, action, target_type, target_id, before_data, after_data
  ) VALUES (
    v_user, v_email, 'admin', 'vidu_shared_pool_status_change', 'vidu_shared_pool', p_pool_id,
    jsonb_build_object('is_active', v_row.is_active),
    jsonb_build_object('is_active', p_is_active)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.log_vidu_shared_pool_status_change(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_vidu_shared_pool_status_change(uuid, boolean) TO authenticated;

-- NOT included here (deliberately -- real secrets don't belong in git
-- history): seeding vidu_shared_pool with actual Vidu key values. After
-- applying this migration, seed manually, e.g.:
--   INSERT INTO public.vidu_shared_pool (vidu_api_key, note)
--   VALUES ('<real vda_... key>', 'seed note');
-- active_provider defaults to 'decart', so applying this migration alone
-- changes nothing for any user until an admin explicitly flips it.
