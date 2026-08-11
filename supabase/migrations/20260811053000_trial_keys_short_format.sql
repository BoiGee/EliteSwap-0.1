-- User-reported: $10 trial keys should be short 11-char alphanumeric codes
-- like the rest of the app, not the old long dct_free-trial_... strings —
-- and 2 recent $10 payments didn't leave the customer with a working code.
--
-- Confirmed root cause: 20260810160000_short_personal_keys.sql switched
-- the MAIN paid-plan flow (issue_api_key_for_payment) to
-- generate_short_access_key() and did a one-time mass regeneration of every
-- EXISTING api_keys.key value to match. But assign_trial_key_from_purchase()
-- — the $10 trial flow — was never updated: it still inserts
-- free_trial_keys.api_key (the old ~70-char dct_free-trial_... pool value)
-- verbatim as api_keys.key. Every trial purchase confirmed before the mass
-- regen got silently "fixed" as a side effect of that one-time backfill;
-- every one confirmed AFTER it (i.e. every one since) gets the old long
-- format again, since the generator itself was never changed. Verified
-- live: exactly one currently sits in this broken state — purchase
-- df281263-e16d-46b6-b191-e0b9d76635af (princessgreyson13@gmail.com,
-- confirmed 2026-08-10T23:43, key never used, full 240000ms balance).
--
-- claim_free_trial_key() (both overloads — the *free*, non-paid trial claim)
-- draws from the identical free_trial_keys pool via the identical pattern
-- and has the exact same bug; fixed alongside for consistency so free-trial
-- users don't hit the same thing.
--
-- free_trial_keys.api_key stops being customer-facing after this — the
-- pool still gates how many trial slots exist and still carries
-- trial_duration_ms (admin-configurable per slot in the Free Trial tab),
-- but the actual key handed to the customer is now always freshly
-- generated via generate_short_access_key(), same as every other key in
-- the app.

CREATE OR REPLACE FUNCTION public.assign_trial_key_from_purchase(p_purchase_id uuid)
RETURNS TABLE(api_key_id uuid, api_key text, expires_at timestamp with time zone, duration_ms bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_purchase   public.trial_purchases%ROWTYPE;
  v_pool_key   public.free_trial_keys%ROWTYPE;
  v_new_api_key public.api_keys%ROWTYPE;
  v_short_key  text;
  v_duration   bigint;
  v_used_count int;
  v_next_session int;
  v_remaining_before int;
  v_remaining_after int;
  v_low_stock_threshold constant int := 10;
  v_service_key text;
BEGIN
  SELECT * INTO v_purchase FROM public.trial_purchases WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trial purchase % not found', p_purchase_id USING ERRCODE = 'P0002';
  END IF;
  IF v_purchase.status <> 'confirmed' THEN
    RAISE EXCEPTION 'Trial purchase % not confirmed', p_purchase_id USING ERRCODE = '22023';
  END IF;

  IF v_purchase.assigned_key_id IS NOT NULL THEN
    SELECT * INTO v_new_api_key
      FROM public.api_keys
     WHERE pool_key_id = v_purchase.assigned_key_id
       AND user_id = v_purchase.user_id
     ORDER BY created_at DESC
     LIMIT 1;
    IF FOUND THEN
      api_key_id := v_new_api_key.id;
      api_key := v_new_api_key.key;
      expires_at := v_new_api_key.expires_at;
      duration_ms := v_new_api_key.remaining_ms;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  SELECT count(*) INTO v_used_count
    FROM public.trial_purchases
    WHERE user_id = v_purchase.user_id
      AND status = 'confirmed'
      AND assigned_key_id IS NOT NULL;
  IF v_used_count >= 2 THEN
    RAISE EXCEPTION 'Trial limit reached' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO v_remaining_before FROM public.free_trial_keys WHERE claimed_by_user_id IS NULL;

  SELECT * INTO v_pool_key FROM public.free_trial_keys
    WHERE claimed_by_user_id IS NULL
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No trial keys available' USING ERRCODE = 'P0002';
  END IF;

  v_duration := COALESCE(v_pool_key.trial_duration_ms, 240000);
  v_short_key := public.generate_short_access_key();

  UPDATE public.free_trial_keys
    SET claimed_by_user_id = v_purchase.user_id,
        claimed_at = now()
    WHERE id = v_pool_key.id;

  v_remaining_after := v_remaining_before - 1;
  IF v_remaining_before > v_low_stock_threshold AND v_remaining_after <= v_low_stock_threshold THEN
    BEGIN
      SELECT decrypted_secret INTO v_service_key
        FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key' LIMIT 1;
      IF v_service_key IS NOT NULL THEN
        PERFORM net.http_post(
          url := 'https://bbxahisheugfryyxfidg.supabase.co/functions/v1/send-admin-push',
          headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_service_key),
          body := jsonb_build_object(
            'event', 'trial_pool_low_stock',
            'title', '$10 trial key pool running low',
            'body', v_remaining_after || ' unclaimed trial key(s) left — top up in Free Trial before purchases start going unfulfilled.',
            'url', '/admin',
            'tag', 'trial-pool-low-stock'
          )
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  -- expires_at intentionally NULL: the 4 minutes only burns down once the
  -- user actually starts a studio session. start_studio_session stamps
  -- expires_at from remaining_ms at session start.
  INSERT INTO public.api_keys (user_id, key, label, is_active, remaining_ms, expires_at, pool_key_id)
    VALUES (
      v_purchase.user_id,
      v_short_key,
      'Trial Key',
      true,
      v_duration,
      NULL,
      v_pool_key.id
    )
    RETURNING * INTO v_new_api_key;

  SELECT COALESCE(MAX(session_number), 0) + 1 INTO v_next_session
    FROM public.free_trial_assignments WHERE user_id = v_purchase.user_id;
  IF v_next_session > 2 THEN v_next_session := 2; END IF;

  INSERT INTO public.free_trial_assignments (user_id, free_trial_key_id, api_key_record_id, session_number)
    VALUES (v_purchase.user_id, v_pool_key.id, v_new_api_key.id, v_next_session)
    ON CONFLICT (user_id, session_number) DO NOTHING;

  UPDATE public.trial_purchases
    SET assigned_key_id = v_pool_key.id,
        updated_at = now()
    WHERE id = p_purchase_id;

  api_key_id := v_new_api_key.id;
  api_key := v_new_api_key.key;
  expires_at := v_new_api_key.expires_at;
  duration_ms := v_duration;
  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_free_trial_key()
RETURNS TABLE(api_key_id uuid, api_key text, expires_at timestamp with time zone, session_number integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_email_confirmed TIMESTAMP WITH TIME ZONE;
  v_used_count INTEGER;
  v_next_session INTEGER;
  v_trial_key_id UUID;
  v_trial_api_key TEXT;
  v_short_key TEXT;
  v_trial_duration_ms BIGINT;
  v_new_api_key_id UUID;
  v_expires_at TIMESTAMP WITH TIME ZONE;
  v_duration_ms BIGINT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT email_confirmed_at INTO v_email_confirmed
  FROM auth.users WHERE id = v_user_id;

  IF v_email_confirmed IS NULL THEN
    RAISE EXCEPTION 'Email not verified. Please confirm your email first.' USING ERRCODE = '42501';
  END IF;

  SELECT COUNT(*) INTO v_used_count
  FROM public.free_trial_assignments
  WHERE user_id = v_user_id;

  IF v_used_count >= 2 THEN
    RAISE EXCEPTION 'You have already used your 2 free trial sessions. Please upgrade to continue.' USING ERRCODE = '42501';
  END IF;

  v_next_session := v_used_count + 1;

  UPDATE public.free_trial_keys AS ftk
  SET claimed_by_user_id = v_user_id,
      claimed_at = now()
  WHERE ftk.id = (
    SELECT id FROM public.free_trial_keys
    WHERE claimed_by_user_id IS NULL
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING ftk.id, ftk.api_key, ftk.trial_duration_ms
  INTO v_trial_key_id, v_trial_api_key, v_trial_duration_ms;

  IF v_trial_key_id IS NULL THEN
    RAISE EXCEPTION 'No free trial keys available right now. Please try again later or upgrade.' USING ERRCODE = 'P0002';
  END IF;

  v_duration_ms := COALESCE(NULLIF(v_trial_duration_ms, 0), 120000);
  v_expires_at := now() + (v_duration_ms || ' milliseconds')::interval;
  v_short_key := public.generate_short_access_key();

  INSERT INTO public.api_keys (user_id, key, label, remaining_ms, expires_at, is_active)
  VALUES (v_user_id, v_short_key, 'Free Trial #' || v_next_session, v_duration_ms, v_expires_at, true)
  RETURNING id INTO v_new_api_key_id;

  INSERT INTO public.free_trial_assignments (user_id, free_trial_key_id, api_key_record_id, session_number)
  VALUES (v_user_id, v_trial_key_id, v_new_api_key_id, v_next_session);

  RETURN QUERY SELECT v_new_api_key_id, v_short_key, v_expires_at, v_next_session;
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_free_trial_key(p_fingerprint text DEFAULT NULL::text, p_ip_hash text DEFAULT NULL::text)
RETURNS TABLE(api_key_id uuid, api_key text, expires_at timestamp with time zone, session_number integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_email_confirmed TIMESTAMP WITH TIME ZONE;
  v_used_count INTEGER;
  v_trial_key_id UUID;
  v_trial_api_key TEXT;
  v_short_key TEXT;
  v_trial_duration_ms BIGINT;
  v_new_api_key_id UUID;
  v_expires_at TIMESTAMP WITH TIME ZONE;
  v_duration_ms BIGINT;
  v_device_collision INTEGER;
  v_ip_user_count INTEGER;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT email_confirmed_at INTO v_email_confirmed
  FROM auth.users WHERE id = v_user_id;

  IF v_email_confirmed IS NULL THEN
    RAISE EXCEPTION 'Email not verified. Please confirm your email first.' USING ERRCODE = '42501';
  END IF;

  SELECT COUNT(*) INTO v_used_count
  FROM public.free_trial_assignments
  WHERE user_id = v_user_id;

  IF v_used_count >= 1 THEN
    RAISE EXCEPTION 'You have already used your free trial session. Please upgrade to continue.' USING ERRCODE = '42501';
  END IF;

  IF p_fingerprint IS NOT NULL AND length(p_fingerprint) >= 8 THEN
    SELECT COUNT(*) INTO v_device_collision
    FROM public.free_trial_assignments
    WHERE device_fingerprint = p_fingerprint
      AND user_id <> v_user_id
      AND override_allowed_at IS NULL;

    IF v_device_collision > 0 THEN
      RAISE EXCEPTION 'Trial already claimed on this device' USING ERRCODE = 'P0010';
    END IF;
  END IF;

  IF p_ip_hash IS NOT NULL AND length(p_ip_hash) >= 8 THEN
    SELECT COUNT(DISTINCT user_id) INTO v_ip_user_count
    FROM public.free_trial_assignments
    WHERE ip_hash = p_ip_hash
      AND user_id <> v_user_id
      AND created_at > now() - interval '30 days'
      AND override_allowed_at IS NULL;

    IF v_ip_user_count >= 2 THEN
      RAISE EXCEPTION 'Too many trials claimed from this network' USING ERRCODE = 'P0011';
    END IF;
  END IF;

  UPDATE public.free_trial_keys AS ftk
  SET claimed_by_user_id = v_user_id,
      claimed_at = now()
  WHERE ftk.id = (
    SELECT id FROM public.free_trial_keys
    WHERE claimed_by_user_id IS NULL
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING ftk.id, ftk.api_key, ftk.trial_duration_ms
  INTO v_trial_key_id, v_trial_api_key, v_trial_duration_ms;

  IF v_trial_key_id IS NULL THEN
    RAISE EXCEPTION 'No free trial keys available right now. Please try again later or upgrade.' USING ERRCODE = 'P0002';
  END IF;

  v_duration_ms := COALESCE(NULLIF(v_trial_duration_ms, 0), 120000);
  v_expires_at := now() + (v_duration_ms || ' milliseconds')::interval;
  v_short_key := public.generate_short_access_key();

  INSERT INTO public.api_keys (user_id, key, label, remaining_ms, expires_at, is_active)
  VALUES (v_user_id, v_short_key, 'Free Trial', v_duration_ms, v_expires_at, true)
  RETURNING id INTO v_new_api_key_id;

  INSERT INTO public.free_trial_assignments (user_id, free_trial_key_id, api_key_record_id, session_number, device_fingerprint, ip_hash)
  VALUES (v_user_id, v_trial_key_id, v_new_api_key_id, 1, p_fingerprint, p_ip_hash);

  RETURN QUERY SELECT v_new_api_key_id, v_short_key, v_expires_at, 1;
END;
$function$;

-- One-time repair: the single currently-known broken case
-- (princessgreyson13@gmail.com, purchase df281263, confirmed 2026-08-10,
-- key never used — full 240000ms balance, safe to re-key in place).
DO $$
DECLARE
  v_key_id uuid := 'b0bcbf53-8faf-415e-9b34-80684828aeb1';
  v_new_key text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.api_keys WHERE id = v_key_id AND length(key) > 11) THEN
    v_new_key := public.generate_short_access_key();
    PERFORM set_config('app.bypass_key_guard', 'on', true);
    UPDATE public.api_keys SET key = v_new_key WHERE id = v_key_id;
    UPDATE public.api_key_secrets SET decart_key = v_new_key, updated_at = now() WHERE api_key_id = v_key_id;
    RAISE NOTICE 'Re-keyed % to %', v_key_id, v_new_key;
  END IF;
END $$;
