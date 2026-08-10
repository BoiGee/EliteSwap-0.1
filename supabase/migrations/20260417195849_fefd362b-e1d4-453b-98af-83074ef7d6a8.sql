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
  v_new_api_key_id UUID;
  v_expires_at TIMESTAMP WITH TIME ZONE;
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

  -- Atomically claim the next available key
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
  RETURNING ftk.id, ftk.api_key INTO v_trial_key_id, v_trial_api_key;

  IF v_trial_key_id IS NULL THEN
    RAISE EXCEPTION 'No free trial keys available right now. Please try again later or upgrade.' USING ERRCODE = 'P0002';
  END IF;

  v_expires_at := now() + interval '2 minutes';

  -- Insert into api_keys (reusing existing timer system)
  INSERT INTO public.api_keys (user_id, key, label, remaining_ms, expires_at, is_active)
  VALUES (v_user_id, v_trial_api_key, 'Free Trial #' || v_next_session, 120000, v_expires_at, true)
  RETURNING id INTO v_new_api_key_id;

  -- Record the assignment
  INSERT INTO public.free_trial_assignments (user_id, free_trial_key_id, api_key_record_id, session_number)
  VALUES (v_user_id, v_trial_key_id, v_new_api_key_id, v_next_session);

  RETURN QUERY SELECT v_new_api_key_id, v_trial_api_key, v_expires_at, v_next_session;
END;
$function$;