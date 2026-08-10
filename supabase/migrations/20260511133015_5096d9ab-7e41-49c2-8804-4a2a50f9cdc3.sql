
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

  v_is_trial := COALESCE(v_row.label, '') ILIKE 'free trial%';
  v_expired := v_row.expires_at IS NOT NULL AND v_row.expires_at <= now();
  v_trial_exhausted := v_is_trial AND v_row.remaining_ms IS NOT NULL AND v_row.remaining_ms <= 0;

  IF NOT v_row.is_active OR (v_is_trial AND v_expired) OR v_trial_exhausted THEN
    RETURN QUERY SELECT false, 'expired_or_inactive'::text, v_row.remaining_ms, v_row.label, v_is_trial;
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

GRANT EXECUTE ON FUNCTION public.check_studio_session(text) TO authenticated;
