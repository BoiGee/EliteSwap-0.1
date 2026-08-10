CREATE OR REPLACE FUNCTION public.start_studio_session(p_key text)
 RETURNS TABLE(ok boolean, reason text, session_id text, expires_at timestamp with time zone, remaining_ms bigint, label text, is_trial boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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
BEGIN
  IF v_uid IS NULL THEN
    RETURN QUERY SELECT false, 'not_authenticated'::text, NULL::text, NULL::timestamptz, NULL::bigint, NULL::text, false;
    RETURN;
  END IF;

  -- Always scope to the current user FIRST. This avoids the duplicate-key bug
  -- where the same Decart key string exists on multiple rows (admin re-used it
  -- across users) and PL/pgSQL's SELECT INTO would otherwise grab whichever
  -- row Postgres returned first — often the wrong user's — and incorrectly
  -- report not_owner to the legitimate owner.
  SELECT * INTO v_row
    FROM public.api_keys
   WHERE key = p_key AND user_id = v_uid
   ORDER BY is_active DESC, created_at DESC
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    -- Distinguish "key truly doesn't exist" from "key exists but belongs to someone else".
    SELECT EXISTS(SELECT 1 FROM public.api_keys WHERE key = p_key) INTO v_foreign_exists;
    IF v_foreign_exists THEN
      RETURN QUERY SELECT false, 'not_owner'::text, NULL::text, NULL::timestamptz, NULL::bigint, NULL::text, false;
    ELSE
      RETURN QUERY SELECT false, 'key_not_found'::text, NULL::text, NULL::timestamptz, NULL::bigint, NULL::text, false;
    END IF;
    RETURN;
  END IF;

  v_is_trial := COALESCE(v_row.label, '') ILIKE 'free trial%';
  v_expired := v_row.expires_at IS NOT NULL AND v_row.expires_at <= now();
  v_trial_exhausted := v_is_trial AND v_row.remaining_ms IS NOT NULL AND v_row.remaining_ms <= 0;

  IF NOT v_row.is_active OR (v_is_trial AND v_expired) OR v_trial_exhausted THEN
    RETURN QUERY SELECT false, 'expired_or_inactive'::text, NULL::text, NULL::timestamptz, v_row.remaining_ms, v_row.label, v_is_trial;
    RETURN;
  END IF;

  -- Single-session lock: 90s stale window.
  IF v_row.active_session_id IS NOT NULL AND v_row.active_session_started_at IS NOT NULL THEN
    v_age_ms := EXTRACT(EPOCH FROM (now() - v_row.active_session_started_at)) * 1000;
    IF v_age_ms < 90000 THEN
      RETURN QUERY SELECT false, 'already_active_elsewhere'::text, NULL::text, NULL::timestamptz, v_row.remaining_ms, v_row.label, v_is_trial;
      RETURN;
    END IF;
  END IF;

  v_new_session := encode(gen_random_bytes(16), 'hex');

  PERFORM set_config('app.bypass_key_guard', 'on', true);

  IF v_row.remaining_ms IS NOT NULL AND v_row.remaining_ms > 0 THEN
    UPDATE public.api_keys
       SET expires_at = now() + (v_row.remaining_ms || ' milliseconds')::interval,
           active_session_id = v_new_session,
           active_session_started_at = now()
     WHERE id = v_row.id;
    RETURN QUERY
      SELECT true, 'ok'::text, v_new_session,
             now() + (v_row.remaining_ms || ' milliseconds')::interval,
             v_row.remaining_ms, v_row.label, v_is_trial;
  ELSE
    UPDATE public.api_keys
       SET active_session_id = v_new_session,
           active_session_started_at = now()
     WHERE id = v_row.id;
    RETURN QUERY
      SELECT true, 'ok_no_timer'::text, v_new_session, NULL::timestamptz, NULL::bigint, v_row.label, v_is_trial;
  END IF;
END;
$function$;