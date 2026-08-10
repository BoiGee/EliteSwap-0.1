
ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS last_session_ended_at timestamp with time zone;

CREATE INDEX IF NOT EXISTS idx_api_keys_last_session_ended_at
  ON public.api_keys (last_session_ended_at DESC);

-- Allow the guard trigger to permit this new managed column when bypass is on
CREATE OR REPLACE FUNCTION public.pause_studio_session(p_key text, p_session_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.api_keys%ROWTYPE;
  v_remaining bigint;
  v_will_deactivate boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;

  SELECT * INTO v_row FROM public.api_keys
   WHERE key = trim(p_key) AND user_id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found_or_not_owner');
  END IF;

  IF v_row.active_session_id IS DISTINCT FROM p_session_id THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'lock_not_held');
  END IF;

  PERFORM set_config('app.bypass_key_guard', 'on', true);

  IF v_row.expires_at IS NOT NULL THEN
    v_remaining := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (v_row.expires_at - now())) * 1000)::bigint);
    v_will_deactivate := v_remaining <= 0;

    UPDATE public.api_keys
       SET remaining_ms = v_remaining,
           expires_at = NULL,
           active_session_id = NULL,
           active_session_started_at = NULL,
           last_session_ended_at = now(),
           is_active = CASE WHEN v_will_deactivate THEN false ELSE is_active END
     WHERE id = v_row.id;

    RETURN jsonb_build_object('ok', true, 'reason', 'paused', 'remaining_ms', v_remaining, 'deactivated', v_will_deactivate);
  ELSE
    UPDATE public.api_keys
       SET active_session_id = NULL,
           active_session_started_at = NULL,
           last_session_ended_at = now()
     WHERE id = v_row.id;
    RETURN jsonb_build_object('ok', true, 'reason', 'released_no_timer');
  END IF;
END;
$function$;

-- Update guard trigger to include last_session_ended_at among managed fields
CREATE OR REPLACE FUNCTION public.tg_api_keys_guard_owner()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_bypass text;
  v_role text := auth.role();
BEGIN
  BEGIN
    v_bypass := current_setting('app.bypass_key_guard', true);
  EXCEPTION WHEN OTHERS THEN
    v_bypass := NULL;
  END;
  IF v_bypass = 'on' THEN
    RETURN NEW;
  END IF;

  IF v_role = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.remaining_ms IS DISTINCT FROM OLD.remaining_ms
     OR NEW.active_session_id IS DISTINCT FROM OLD.active_session_id
     OR NEW.active_session_started_at IS DISTINCT FROM OLD.active_session_started_at
     OR NEW.last_session_ended_at IS DISTINCT FROM OLD.last_session_ended_at
     OR NEW.is_active IS DISTINCT FROM OLD.is_active
  THEN
    IF NOT public.has_role('admin'::app_role) THEN
      RAISE EXCEPTION 'Not allowed: api_keys timer/session fields can only be updated through start/heartbeat/pause functions'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
