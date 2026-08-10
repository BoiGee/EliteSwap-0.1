
-- Studio session history table
CREATE TABLE public.studio_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id uuid NOT NULL,
  user_id uuid NOT NULL,
  key_label text,
  is_trial boolean NOT NULL DEFAULT false,
  session_id text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  end_reason text,
  duration_ms bigint,
  remaining_ms_at_start bigint,
  remaining_ms_at_end bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_studio_sessions_user_id ON public.studio_sessions(user_id);
CREATE INDEX idx_studio_sessions_api_key_id ON public.studio_sessions(api_key_id);
CREATE INDEX idx_studio_sessions_started_at ON public.studio_sessions(started_at DESC);
CREATE INDEX idx_studio_sessions_ended_at ON public.studio_sessions(ended_at DESC);
CREATE UNIQUE INDEX idx_studio_sessions_session_id_open
  ON public.studio_sessions(session_id) WHERE ended_at IS NULL;

ALTER TABLE public.studio_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view all studio sessions"
  ON public.studio_sessions FOR SELECT TO authenticated
  USING (has_role('admin'::app_role));

CREATE POLICY "Users can view own studio sessions"
  ON public.studio_sessions FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- inserts/updates are only through SECURITY DEFINER RPCs; no direct policies.

-- Patch start_studio_session to also log a history row
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

  v_is_trial := COALESCE(v_row.label, '') ILIKE 'free trial%';
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

  -- Log the new session row (history)
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

-- Patch heartbeat to update last_heartbeat_at on history
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
   WHERE key = trim(p_key) AND user_id = v_uid AND active_session_id = p_session_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM set_config('app.bypass_key_guard', 'on', true);
  UPDATE public.api_keys
     SET active_session_started_at = now()
   WHERE id = v_row_id AND active_session_id = p_session_id;

  UPDATE public.studio_sessions
     SET last_heartbeat_at = now()
   WHERE session_id = p_session_id AND ended_at IS NULL;

  RETURN true;
END;
$function$;

-- Patch pause to close the history row
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

    UPDATE public.studio_sessions
       SET ended_at = now(),
           end_reason = 'user_pause',
           remaining_ms_at_end = v_remaining,
           duration_ms = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::bigint)
     WHERE session_id = p_session_id AND ended_at IS NULL;

    RETURN jsonb_build_object('ok', true, 'reason', 'paused', 'remaining_ms', v_remaining, 'deactivated', v_will_deactivate);
  ELSE
    UPDATE public.api_keys
       SET active_session_id = NULL,
           active_session_started_at = NULL,
           last_session_ended_at = now()
     WHERE id = v_row.id;

    UPDATE public.studio_sessions
       SET ended_at = now(),
           end_reason = 'user_pause',
           duration_ms = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::bigint)
     WHERE session_id = p_session_id AND ended_at IS NULL;

    RETURN jsonb_build_object('ok', true, 'reason', 'released_no_timer');
  END IF;
END;
$function$;

-- Admin-callable: close an orphaned/expired/force-released session
CREATE OR REPLACE FUNCTION public.close_studio_session(p_api_key_id uuid, p_reason text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.api_keys%ROWTYPE;
  v_remaining bigint;
  v_will_deactivate boolean := false;
  v_session_id text;
BEGIN
  IF NOT has_role('admin'::app_role) THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;
  IF p_reason NOT IN ('force_release','orphaned_auto','expired') THEN
    RAISE EXCEPTION 'Invalid reason' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row FROM public.api_keys WHERE id = p_api_key_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  v_session_id := v_row.active_session_id;

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
  ELSE
    v_remaining := v_row.remaining_ms;
    UPDATE public.api_keys
       SET active_session_id = NULL,
           active_session_started_at = NULL,
           last_session_ended_at = now()
     WHERE id = v_row.id;
  END IF;

  IF v_session_id IS NOT NULL THEN
    UPDATE public.studio_sessions
       SET ended_at = now(),
           end_reason = p_reason,
           remaining_ms_at_end = v_remaining,
           duration_ms = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::bigint)
     WHERE session_id = v_session_id AND ended_at IS NULL;
  END IF;

  RETURN true;
END;
$function$;

-- Reaper: closes orphaned/expired open sessions automatically.
CREATE OR REPLACE FUNCTION public.reap_orphaned_studio_sessions()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer := 0;
  r RECORD;
  v_remaining bigint;
BEGIN
  PERFORM set_config('app.bypass_key_guard', 'on', true);

  -- Close history rows whose heartbeat is stale (>2 min) or whose key expired
  FOR r IN
    SELECT s.*, k.expires_at AS key_expires_at, k.remaining_ms AS key_remaining_ms, k.active_session_id AS key_active_session
    FROM public.studio_sessions s
    LEFT JOIN public.api_keys k ON k.id = s.api_key_id
    WHERE s.ended_at IS NULL
      AND (
        s.last_heartbeat_at < now() - interval '2 minutes'
        OR (k.expires_at IS NOT NULL AND k.expires_at <= now())
        OR k.active_session_id IS DISTINCT FROM s.session_id
      )
  LOOP
    -- compute remaining at end if key still has expires_at
    IF r.key_expires_at IS NOT NULL THEN
      v_remaining := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (r.key_expires_at - now())) * 1000)::bigint);
    ELSE
      v_remaining := r.key_remaining_ms;
    END IF;

    UPDATE public.studio_sessions
       SET ended_at = COALESCE(last_heartbeat_at, now()),
           end_reason = CASE
             WHEN r.key_expires_at IS NOT NULL AND r.key_expires_at <= now() THEN 'expired'
             ELSE 'orphaned_auto'
           END,
           remaining_ms_at_end = v_remaining,
           duration_ms = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (COALESCE(last_heartbeat_at, now()) - started_at)) * 1000)::bigint)
     WHERE id = r.id;

    -- If the api_keys row still points at this orphaned session, clear it
    IF r.key_active_session = r.session_id THEN
      UPDATE public.api_keys
         SET active_session_id = NULL,
             active_session_started_at = NULL,
             last_session_ended_at = now(),
             remaining_ms = CASE WHEN expires_at IS NOT NULL
                                 THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (expires_at - now())) * 1000)::bigint)
                                 ELSE remaining_ms END,
             expires_at = NULL,
             is_active = CASE WHEN expires_at IS NOT NULL
                                AND GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (expires_at - now())) * 1000)::bigint) <= 0
                              THEN false ELSE is_active END
       WHERE id = r.api_key_id;
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$;

-- Schedule reaper every minute (pg_cron)
CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.schedule(
  'reap-orphaned-studio-sessions',
  '* * * * *',
  $$ SELECT public.reap_orphaned_studio_sessions(); $$
);
