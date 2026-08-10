
ALTER TABLE public.free_trial_assignments DROP CONSTRAINT IF EXISTS free_trial_assignments_session_number_check;
ALTER TABLE public.free_trial_assignments ADD CONSTRAINT free_trial_assignments_session_number_check CHECK (session_number = 1) NOT VALID;

CREATE OR REPLACE FUNCTION public.claim_free_trial_key(p_fingerprint text DEFAULT NULL, p_ip_hash text DEFAULT NULL)
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

  INSERT INTO public.api_keys (user_id, key, label, remaining_ms, expires_at, is_active)
  VALUES (v_user_id, v_trial_api_key, 'Free Trial', v_duration_ms, v_expires_at, true)
  RETURNING id INTO v_new_api_key_id;

  INSERT INTO public.free_trial_assignments (user_id, free_trial_key_id, api_key_record_id, session_number, device_fingerprint, ip_hash)
  VALUES (v_user_id, v_trial_key_id, v_new_api_key_id, 1, p_fingerprint, p_ip_hash);

  RETURN QUERY SELECT v_new_api_key_id, v_trial_api_key, v_expires_at, 1;
END;
$function$;
