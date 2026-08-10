-- close_studio_session() — used by the Live Connections admin tab's "Force
-- release"/"End session" buttons AND its own automatic orphan-release
-- feature — billed duration_ms/remaining_ms as raw wall-clock elapsed time
-- with no floor and no teardown tail, unlike every other close path
-- (heartbeat_studio_session, pause_studio_session, reap_orphaned_studio_
-- sessions), which all apply a warmup/handshake floor plus a teardown
-- tail. Verified against the live function definition before writing
-- this — confirmed identical on both audits. Impact: any session an
-- admin manually force-closes or ends while under the ~35s floor+tail
-- threshold was billed for only its real (smaller) elapsed time instead.
-- The automatic orphan-release path races the server-side reaper (which
-- runs every 2s and almost always wins), so its real-world exposure was
-- small, but "Force release"/"End session" are deliberate admin actions
-- with no such race — every one of those under-billed relative to the
-- established model. Brought in line with pause_studio_session()'s exact
-- computation.
CREATE OR REPLACE FUNCTION public.close_studio_session(p_api_key_id uuid, p_reason text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.api_keys%ROWTYPE;
  v_session RECORD;
  v_remaining bigint;
  v_will_deactivate boolean := false;
  v_session_id text;
  v_elapsed bigint;
  v_bill bigint;
  v_floor bigint;
  v_min_bill bigint;
  v_warmup_ms bigint;
  v_tail_ms bigint;
BEGIN
  IF NOT has_role('admin'::app_role) THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;
  IF p_reason NOT IN ('force_release','orphaned_auto','expired') THEN
    RAISE EXCEPTION 'Invalid reason' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(handshake_floor_ms, 8000),
         COALESCE(warmup_grace_ms, 30000),
         COALESCE(teardown_tail_ms, 2000)
    INTO v_min_bill, v_warmup_ms, v_tail_ms
    FROM public.studio_pricing_config LIMIT 1;
  IF v_min_bill IS NULL THEN v_min_bill := 8000; END IF;
  IF v_warmup_ms IS NULL THEN v_warmup_ms := 30000; END IF;
  IF v_tail_ms IS NULL THEN v_tail_ms := 2000; END IF;

  SELECT * INTO v_row FROM public.api_keys WHERE id = p_api_key_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  v_session_id := v_row.active_session_id;

  PERFORM set_config('app.bypass_key_guard', 'on', true);

  IF v_session_id IS NOT NULL THEN
    SELECT s.started_at, s.first_heartbeat_at, s.remaining_ms_at_start,
           COALESCE(s.min_bill_ms, v_min_bill) AS min_bill
      INTO v_session
      FROM public.studio_sessions s
     WHERE s.session_id = v_session_id
       AND s.api_key_id = v_row.id
       AND s.ended_at IS NULL
     LIMIT 1;

    IF v_session.started_at IS NOT NULL THEN
      v_elapsed := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - v_session.started_at)) * 1000)::bigint);
      IF v_session.first_heartbeat_at IS NULL AND v_elapsed < v_warmup_ms THEN
        v_floor := v_session.min_bill;
      ELSE
        v_floor := GREATEST(v_session.min_bill, v_warmup_ms);
      END IF;
      v_bill := GREATEST(v_elapsed, v_floor) + v_tail_ms;
      IF v_session.remaining_ms_at_start IS NOT NULL THEN
        v_bill := LEAST(v_bill, v_session.remaining_ms_at_start);
      END IF;
    ELSE
      -- No matching open session row found (shouldn't happen in practice,
      -- but fall back to the old unfloored computation rather than fail).
      v_bill := NULL;
    END IF;
  ELSE
    v_bill := NULL;
  END IF;

  IF v_row.expires_at IS NOT NULL THEN
    IF v_bill IS NOT NULL AND v_session.remaining_ms_at_start IS NOT NULL THEN
      v_remaining := GREATEST(0, v_session.remaining_ms_at_start - v_bill);
    ELSE
      v_remaining := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (v_row.expires_at - now())) * 1000)::bigint);
    END IF;
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
    IF v_bill IS NOT NULL AND v_row.remaining_ms IS NOT NULL THEN
      v_remaining := GREATEST(0, v_row.remaining_ms - v_bill);
    ELSE
      v_remaining := v_row.remaining_ms;
    END IF;
    UPDATE public.api_keys
       SET remaining_ms = v_remaining,
           active_session_id = NULL,
           active_session_started_at = NULL,
           last_session_ended_at = now()
     WHERE id = v_row.id;
  END IF;

  IF v_session_id IS NOT NULL THEN
    UPDATE public.studio_sessions
       SET ended_at = now(),
           end_reason = p_reason,
           remaining_ms_at_end = v_remaining,
           duration_ms = COALESCE(v_bill, GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::bigint)),
           last_debit_at = now()
     WHERE session_id = v_session_id AND ended_at IS NULL;
  END IF;

  RETURN true;
END;
$function$;
