CREATE OR REPLACE FUNCTION public.record_studio_connect_attempt(p_key text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_key public.api_keys%ROWTYPE;
  v_session_id text := gen_random_uuid()::text;
  v_row_id uuid;
BEGIN
  IF v_user IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_key FROM public.api_keys
  WHERE key_value = p_key AND user_id = v_user
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.studio_sessions (
    api_key_id, user_id, key_label, is_trial, session_id,
    started_at, last_heartbeat_at, ended_at, end_reason,
    duration_ms, remaining_ms_at_start, remaining_ms_at_end
  ) VALUES (
    v_key.id, v_user, v_key.label, COALESCE(v_key.is_trial, false), v_session_id,
    now(), now(), now(), 'connect_attempt',
    0, v_key.remaining_ms, v_key.remaining_ms
  )
  RETURNING id INTO v_row_id;

  BEGIN
    INSERT INTO public.user_activity_logs (user_id, action, page, metadata)
    VALUES (v_user, 'studio_connect_attempt', '/studio', jsonb_build_object('api_key_id', v_key.id));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN v_row_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_studio_connect_attempt(text) TO authenticated;