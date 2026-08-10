
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
  v_duration   bigint;
  v_used_count int;
  v_next_session int;
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

  SELECT * INTO v_pool_key FROM public.free_trial_keys
    WHERE claimed_by_user_id IS NULL
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No trial keys available' USING ERRCODE = 'P0002';
  END IF;

  v_duration := COALESCE(v_pool_key.trial_duration_ms, 240000);

  UPDATE public.free_trial_keys
    SET claimed_by_user_id = v_purchase.user_id,
        claimed_at = now()
    WHERE id = v_pool_key.id;

  -- expires_at intentionally NULL: the 4 minutes only burns down once the
  -- user actually starts a studio session. start_studio_session stamps
  -- expires_at from remaining_ms at session start.
  INSERT INTO public.api_keys (user_id, key, label, is_active, remaining_ms, expires_at, pool_key_id)
    VALUES (
      v_purchase.user_id,
      v_pool_key.api_key,
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

REVOKE ALL ON FUNCTION public.assign_trial_key_from_purchase(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_trial_key_from_purchase(uuid) TO service_role;

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
    RETURN QUERY
      SELECT true, 'ok'::text, v_new_session,
             now() + (v_effective_remaining || ' milliseconds')::interval,
             v_effective_remaining, v_row.label, v_is_trial;
  ELSE
    RETURN QUERY
      SELECT true, 'ok_no_timer'::text, v_new_session, NULL::timestamptz, NULL::bigint, v_row.label, v_is_trial;
  END IF;
END;
$function$;

-- Backfill: clear wall-clock expiry on untouched trial keys still holding their full quota.
-- Bypass api_keys guard trigger because this is a controlled admin migration.
DO $$
BEGIN
  PERFORM set_config('app.bypass_key_guard', 'on', true);
  UPDATE public.api_keys k
     SET expires_at = NULL
   WHERE k.pool_key_id IS NOT NULL
     AND k.remaining_ms IS NOT NULL
     AND k.remaining_ms > 0
     AND k.active_session_id IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.studio_sessions s WHERE s.api_key_id = k.id
     );
END $$;
