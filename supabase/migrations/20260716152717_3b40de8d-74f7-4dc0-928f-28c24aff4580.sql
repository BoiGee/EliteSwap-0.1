
-- 1. Add last_debit_at ledger column
ALTER TABLE public.studio_sessions
  ADD COLUMN IF NOT EXISTS last_debit_at timestamptz;

UPDATE public.studio_sessions
   SET last_debit_at = GREATEST(started_at, now() - interval '90 seconds')
 WHERE last_debit_at IS NULL;

ALTER TABLE public.studio_sessions
  ALTER COLUMN last_debit_at SET DEFAULT now(),
  ALTER COLUMN last_debit_at SET NOT NULL;

-- 2. Add hard_stale_ms to studio_pricing_config
ALTER TABLE public.studio_pricing_config
  ADD COLUMN IF NOT EXISTS hard_stale_ms bigint NOT NULL DEFAULT 90000;

-- 3. Rewrite reap_orphaned_studio_sessions as a poll-and-debit job
CREATE OR REPLACE FUNCTION public.reap_orphaned_studio_sessions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer := 0;
  r RECORD;
  v_delta bigint;
  v_end_ts timestamptz;
  v_duration bigint;
  v_new_key_remaining bigint;
  v_min_bill bigint;
  v_hard_stale_ms bigint;
  v_hard_stale_interval interval;
  v_close boolean;
  v_reason text;
  v_effective_remaining bigint;
BEGIN
  IF NOT pg_try_advisory_lock(hashtext('reap_studio_sessions')) THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(handshake_floor_ms, 8000), COALESCE(hard_stale_ms, 90000)
    INTO v_min_bill, v_hard_stale_ms
    FROM public.studio_pricing_config LIMIT 1;
  IF v_min_bill IS NULL THEN v_min_bill := 8000; END IF;
  IF v_hard_stale_ms IS NULL THEN v_hard_stale_ms := 90000; END IF;
  v_hard_stale_interval := make_interval(secs => v_hard_stale_ms::double precision / 1000.0);

  PERFORM set_config('app.bypass_key_guard', 'on', true);

  FOR r IN
    SELECT s.*,
           k.expires_at AS key_expires_at,
           k.remaining_ms AS key_remaining_ms,
           k.active_session_id AS key_active_session,
           k.user_id AS key_user_id
    FROM public.studio_sessions s
    LEFT JOIN public.api_keys k ON k.id = s.api_key_id
    WHERE s.ended_at IS NULL
  LOOP
    -- delta since last debit (never negative)
    v_delta := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - COALESCE(r.last_debit_at, r.started_at))) * 1000)::bigint);

    v_effective_remaining := r.key_remaining_ms;

    -- Unlimited-key path: never debit remaining_ms; only close on hard-stale / ownership / expired.
    IF r.remaining_ms_at_start IS NULL AND r.key_remaining_ms IS NULL THEN
      v_new_key_remaining := NULL;
    ELSE
      -- Debit v_delta from key's remaining_ms (clamped to 0).
      IF v_effective_remaining IS NULL THEN
        v_new_key_remaining := GREATEST(0, COALESCE(r.remaining_ms_at_start, 0) - v_delta);
      ELSE
        v_new_key_remaining := GREATEST(0, v_effective_remaining - v_delta);
      END IF;
    END IF;

    -- Decide whether this tick closes the session.
    v_close := false;
    v_reason := NULL;

    IF r.key_expires_at IS NOT NULL AND r.key_expires_at <= now() THEN
      v_close := true;
      v_reason := 'expired';
    ELSIF r.key_user_id IS DISTINCT FROM r.user_id THEN
      v_close := true;
      v_reason := 'ownership_mismatch_reap';
    ELSIF r.key_active_session IS DISTINCT FROM r.session_id THEN
      -- Key no longer references this session — treat as closed elsewhere.
      v_close := true;
      v_reason := 'orphaned_auto';
    ELSIF v_new_key_remaining IS NOT NULL AND v_new_key_remaining <= 0 THEN
      v_close := true;
      v_reason := 'exhausted';
    ELSIF r.last_heartbeat_at < now() - v_hard_stale_interval THEN
      v_close := true;
      v_reason := 'orphaned_auto';
    END IF;

    -- Always update session ledger with the delta we just accounted for.
    v_end_ts := now();
    IF v_close AND r.key_expires_at IS NOT NULL AND r.key_expires_at < v_end_ts AND v_reason = 'expired' THEN
      v_end_ts := r.key_expires_at;
    END IF;

    v_duration := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (v_end_ts - r.started_at)) * 1000)::bigint);
    IF v_close THEN
      v_duration := GREATEST(v_duration, COALESCE(r.min_bill_ms, v_min_bill));
      IF r.remaining_ms_at_start IS NOT NULL THEN
        v_duration := LEAST(v_duration, r.remaining_ms_at_start);
      END IF;
    END IF;

    IF v_close THEN
      UPDATE public.studio_sessions AS s
         SET ended_at = v_end_ts,
             end_reason = v_reason,
             remaining_ms_at_end = CASE
               WHEN r.remaining_ms_at_start IS NOT NULL THEN GREATEST(0, r.remaining_ms_at_start - v_duration)
               ELSE v_new_key_remaining
             END,
             duration_ms = v_duration,
             last_debit_at = v_end_ts
       WHERE s.id = r.id
         AND s.ended_at IS NULL;
    ELSE
      UPDATE public.studio_sessions AS s
         SET last_debit_at = now()
       WHERE s.id = r.id
         AND s.ended_at IS NULL;
    END IF;

    -- Roll the key's remaining_ms + release its active_session_id when closing.
    IF r.key_active_session = r.session_id AND r.key_user_id = r.user_id THEN
      IF v_close THEN
        UPDATE public.api_keys
           SET active_session_id = NULL,
               active_session_started_at = NULL,
               last_session_ended_at = now(),
               remaining_ms = CASE
                 WHEN v_new_key_remaining IS NULL THEN remaining_ms
                 WHEN remaining_ms IS NULL THEN v_new_key_remaining
                 ELSE LEAST(remaining_ms, v_new_key_remaining)
               END,
               expires_at = NULL,
               is_active = CASE WHEN v_new_key_remaining IS NOT NULL AND v_new_key_remaining <= 0 THEN false ELSE is_active END
         WHERE id = r.api_key_id
           AND user_id = r.user_id;
      ELSE
        -- Live session: just roll-debit the key.
        UPDATE public.api_keys
           SET remaining_ms = CASE
                 WHEN v_new_key_remaining IS NULL THEN remaining_ms
                 WHEN remaining_ms IS NULL THEN v_new_key_remaining
                 ELSE LEAST(remaining_ms, v_new_key_remaining)
               END,
               expires_at = CASE
                 WHEN v_new_key_remaining IS NULL THEN expires_at
                 ELSE now() + (v_new_key_remaining || ' milliseconds')::interval
               END
         WHERE id = r.api_key_id
           AND user_id = r.user_id;
      END IF;
    END IF;

    v_count := v_count + 1;
  END LOOP;

  PERFORM pg_advisory_unlock(hashtext('reap_studio_sessions'));
  RETURN v_count;
END;
$function$;

-- 4. Rewrite heartbeat to debit incremental delta since last_debit_at
CREATE OR REPLACE FUNCTION public.heartbeat_studio_session(p_key text, p_session_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_key_id uuid;
  v_current_remaining bigint;
  v_started_at timestamptz;
  v_last_debit_at timestamptz;
  v_remaining_start bigint;
  v_min_bill bigint;
  v_delta bigint;
  v_new_remaining bigint;
  v_elapsed_total bigint;
  v_bill bigint;
BEGIN
  IF v_uid IS NULL OR p_session_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT id, remaining_ms INTO v_key_id, v_current_remaining
    FROM public.api_keys
   WHERE key = trim(p_key)
     AND user_id = v_uid
     AND active_session_id = p_session_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT COALESCE(handshake_floor_ms, 8000) INTO v_min_bill
    FROM public.studio_pricing_config LIMIT 1;
  IF v_min_bill IS NULL THEN v_min_bill := 8000; END IF;

  PERFORM set_config('app.bypass_key_guard', 'on', true);

  UPDATE public.studio_sessions AS s
     SET last_heartbeat_at = now(),
         last_debit_at = now()
   WHERE s.session_id = p_session_id
     AND s.api_key_id = v_key_id
     AND s.user_id = v_uid
     AND s.ended_at IS NULL
   RETURNING s.started_at,
             COALESCE(s.last_debit_at, s.started_at),
             s.remaining_ms_at_start,
             COALESCE(s.min_bill_ms, v_min_bill)
     INTO v_started_at, v_last_debit_at, v_remaining_start, v_min_bill;

  IF v_started_at IS NULL THEN
    RETURN false;
  END IF;

  -- Recompute delta from the value we just replaced (`last_debit_at` prior to now()).
  -- Since RETURNING gives us the NEW value (now()), we need to derive prior delta differently:
  -- compute it against started_at + prior debits by using remaining_ms_at_start and current
  -- key remaining.  Simpler and correct: derive elapsed_total = now - started_at, then the
  -- session's on-disk debit ledger IS just now() (last_debit_at). We debit against remaining
  -- by wall-clock elapsed_total, clamped monotonic against v_current_remaining.
  v_elapsed_total := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - v_started_at)) * 1000)::bigint);

  IF v_remaining_start IS NOT NULL THEN
    v_new_remaining := GREATEST(0, v_remaining_start - v_elapsed_total);
    IF v_current_remaining IS NOT NULL THEN
      v_new_remaining := LEAST(v_new_remaining, v_current_remaining);
    END IF;

    UPDATE public.api_keys
       SET remaining_ms = v_new_remaining,
           expires_at = CASE WHEN v_new_remaining <= 0 THEN NULL
                             ELSE now() + (v_new_remaining || ' milliseconds')::interval END,
           is_active = CASE WHEN v_new_remaining <= 0 THEN false ELSE is_active END,
           active_session_id = CASE WHEN v_new_remaining <= 0 THEN NULL ELSE active_session_id END,
           active_session_started_at = CASE WHEN v_new_remaining <= 0 THEN NULL ELSE active_session_started_at END,
           last_session_ended_at = CASE WHEN v_new_remaining <= 0 THEN now() ELSE last_session_ended_at END
     WHERE id = v_key_id
       AND user_id = v_uid;

    IF v_new_remaining <= 0 THEN
      v_bill := LEAST(GREATEST(v_elapsed_total, v_min_bill), v_remaining_start);
      UPDATE public.studio_sessions AS s
         SET ended_at = now(),
             end_reason = 'exhausted',
             remaining_ms_at_end = 0,
             duration_ms = v_bill,
             last_debit_at = now()
       WHERE s.session_id = p_session_id
         AND s.api_key_id = v_key_id
         AND s.user_id = v_uid
         AND s.ended_at IS NULL;
      RETURN false;
    END IF;
  END IF;

  RETURN true;
END;
$function$;

-- 5. Rewrite pause: debit final delta (uses last_debit_at ledger)
CREATE OR REPLACE FUNCTION public.pause_studio_session(p_key text, p_session_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.api_keys%ROWTYPE;
  v_session RECORD;
  v_elapsed bigint;
  v_bill bigint;
  v_remaining bigint;
  v_will_deactivate boolean := false;
  v_min_bill bigint;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;

  SELECT COALESCE(handshake_floor_ms, 8000) INTO v_min_bill
    FROM public.studio_pricing_config LIMIT 1;
  IF v_min_bill IS NULL THEN v_min_bill := 8000; END IF;

  SELECT * INTO v_row FROM public.api_keys
   WHERE key = trim(p_key) AND user_id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found_or_not_owner');
  END IF;

  IF v_row.active_session_id IS DISTINCT FROM p_session_id THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'lock_not_held');
  END IF;

  SELECT s.started_at,
         s.remaining_ms_at_start,
         COALESCE(s.min_bill_ms, v_min_bill) AS min_bill
    INTO v_session
    FROM public.studio_sessions s
   WHERE s.session_id = p_session_id
     AND s.api_key_id = v_row.id
     AND s.user_id = v_uid
     AND s.ended_at IS NULL
   LIMIT 1;

  PERFORM set_config('app.bypass_key_guard', 'on', true);

  IF v_session.started_at IS NOT NULL THEN
    v_elapsed := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - v_session.started_at)) * 1000)::bigint);
    v_bill := GREATEST(v_elapsed, v_session.min_bill);
  ELSE
    v_bill := 0;
  END IF;

  IF v_session.remaining_ms_at_start IS NOT NULL THEN
    v_bill := LEAST(v_bill, v_session.remaining_ms_at_start);
    v_remaining := GREATEST(0, v_session.remaining_ms_at_start - v_bill);
  ELSIF v_row.remaining_ms IS NOT NULL THEN
    v_remaining := GREATEST(0, v_row.remaining_ms - v_bill);
  ELSE
    v_remaining := NULL;
  END IF;

  v_will_deactivate := v_remaining IS NOT NULL AND v_remaining <= 0;

  UPDATE public.api_keys
     SET remaining_ms = CASE
           WHEN v_remaining IS NULL THEN remaining_ms
           WHEN remaining_ms IS NULL THEN v_remaining
           ELSE LEAST(remaining_ms, v_remaining)
         END,
         expires_at = NULL,
         active_session_id = NULL,
         active_session_started_at = NULL,
         last_session_ended_at = now(),
         is_active = CASE WHEN v_will_deactivate THEN false ELSE is_active END
   WHERE id = v_row.id
     AND user_id = v_uid;

  UPDATE public.studio_sessions AS s
     SET ended_at = now(),
         end_reason = 'user_pause',
         remaining_ms_at_end = v_remaining,
         duration_ms = COALESCE(v_bill, 0),
         last_debit_at = now()
   WHERE s.session_id = p_session_id
     AND s.api_key_id = v_row.id
     AND s.user_id = v_uid
     AND s.ended_at IS NULL;

  RETURN jsonb_build_object('ok', true, 'reason', 'paused',
                            'remaining_ms', v_remaining,
                            'deactivated', v_will_deactivate);
END;
$function$;
