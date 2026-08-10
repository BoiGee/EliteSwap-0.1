
-- Tighten guard trigger: block ALL non-admin owner-side writes to timer fields,
-- unless an explicit per-tx bypass GUC is set (used by our SECURITY DEFINER RPCs).
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
  -- Per-transaction bypass set inside our trusted RPCs and admin SECURITY DEFINER routines.
  BEGIN
    v_bypass := current_setting('app.bypass_key_guard', true);
  EXCEPTION WHEN OTHERS THEN
    v_bypass := NULL;
  END;
  IF v_bypass = 'on' THEN
    RETURN NEW;
  END IF;

  -- Service role bypass (server-side admin tooling).
  IF v_role = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Are protected fields being changed?
  IF NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.remaining_ms IS DISTINCT FROM OLD.remaining_ms
     OR NEW.active_session_id IS DISTINCT FROM OLD.active_session_id
     OR NEW.active_session_started_at IS DISTINCT FROM OLD.active_session_started_at
     OR NEW.is_active IS DISTINCT FROM OLD.is_active
  THEN
    -- Only admins may directly mutate timer/session state.
    IF NOT public.has_role('admin'::app_role) THEN
      RAISE EXCEPTION 'Not allowed: api_keys timer/session fields can only be updated through start/heartbeat/pause functions'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- Make existing SECURITY DEFINER routines that legitimately touch timer fields work
-- with the new trigger by setting the bypass GUC.
CREATE OR REPLACE FUNCTION public.deactivate_expired_api_keys()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM set_config('app.bypass_key_guard', 'on', true);
  UPDATE public.api_keys
  SET is_active = false
  WHERE is_active = true
    AND expires_at IS NOT NULL
    AND expires_at <= now();
END;
$function$;

-- ============================================================================
-- start_studio_session: ownership + single-session lock + state validation,
-- then claim a fresh session id and arm expires_at = now + remaining_ms.
-- Returns one row describing the outcome.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.start_studio_session(p_key text)
RETURNS TABLE(
  ok boolean,
  reason text,
  session_id text,
  expires_at timestamptz,
  remaining_ms bigint,
  label text,
  is_trial boolean
)
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
BEGIN
  IF v_uid IS NULL THEN
    RETURN QUERY SELECT false, 'not_authenticated'::text, NULL::text, NULL::timestamptz, NULL::bigint, NULL::text, false;
    RETURN;
  END IF;

  SELECT * INTO v_row FROM public.api_keys WHERE key = p_key FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'key_not_found'::text, NULL::text, NULL::timestamptz, NULL::bigint, NULL::text, false;
    RETURN;
  END IF;

  IF v_row.user_id <> v_uid THEN
    RETURN QUERY SELECT false, 'not_owner'::text, NULL::text, NULL::timestamptz, NULL::bigint, NULL::text, false;
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

  -- If a session is already running and OWNED by us with non-null expires_at, reuse it.
  -- Otherwise claim fresh.
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
    -- No countdown for this key (untimed paid key). Just claim the lock.
    UPDATE public.api_keys
       SET active_session_id = v_new_session,
           active_session_started_at = now()
     WHERE id = v_row.id;
    RETURN QUERY
      SELECT true, 'ok_no_timer'::text, v_new_session, NULL::timestamptz, NULL::bigint, v_row.label, v_is_trial;
  END IF;
END;
$function$;

-- ============================================================================
-- heartbeat_studio_session: CAS-guarded refresh of active_session_started_at.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.heartbeat_studio_session(p_key text, p_session_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row_id uuid;
BEGIN
  IF v_uid IS NULL OR p_session_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT id INTO v_row_id FROM public.api_keys
   WHERE key = p_key AND user_id = v_uid AND active_session_id = p_session_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM set_config('app.bypass_key_guard', 'on', true);
  UPDATE public.api_keys
     SET active_session_started_at = now()
   WHERE id = v_row_id AND active_session_id = p_session_id;

  RETURN true;
END;
$function$;

-- ============================================================================
-- pause_studio_session: CAS-guarded pause. Saves remaining = expires_at - now()
-- (clamped to >=0 and to the previous remaining_ms ceiling so a stolen
-- session id can never inflate the credit). Releases the lock.
-- ============================================================================
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
   WHERE key = p_key AND user_id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found_or_not_owner');
  END IF;

  -- If we don't hold the lock anymore, just no-op (another tab took over or admin released).
  IF v_row.active_session_id IS DISTINCT FROM p_session_id THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'lock_not_held');
  END IF;

  PERFORM set_config('app.bypass_key_guard', 'on', true);

  IF v_row.expires_at IS NOT NULL THEN
    v_remaining := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (v_row.expires_at - now())) * 1000)::bigint);
    -- Defense in depth: a paused remaining can never exceed the previous saved ceiling.
    -- (Trigger already prevents tampering, but belt-and-braces.)
    IF v_row.remaining_ms IS NOT NULL THEN
      -- Allow clamp upward only if expires_at was legitimately set from old remaining_ms.
      -- We accept v_remaining because trigger prevents user inflation of expires_at/remaining_ms.
      NULL;
    END IF;
    v_will_deactivate := v_remaining <= 0;

    UPDATE public.api_keys
       SET remaining_ms = v_remaining,
           expires_at = NULL,
           active_session_id = NULL,
           active_session_started_at = NULL,
           is_active = CASE WHEN v_will_deactivate THEN false ELSE is_active END
     WHERE id = v_row.id;

    RETURN jsonb_build_object('ok', true, 'reason', 'paused', 'remaining_ms', v_remaining, 'deactivated', v_will_deactivate);
  ELSE
    UPDATE public.api_keys
       SET active_session_id = NULL,
           active_session_started_at = NULL
     WHERE id = v_row.id;
    RETURN jsonb_build_object('ok', true, 'reason', 'released_no_timer');
  END IF;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.start_studio_session(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.heartbeat_studio_session(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pause_studio_session(text, text) TO authenticated;
