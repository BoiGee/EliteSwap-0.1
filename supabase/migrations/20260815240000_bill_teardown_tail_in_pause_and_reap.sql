-- "Unbilled Seconds" investigation (2026-08-15) found the ~2s Decart
-- connection-teardown tail (studio_pricing_config.teardown_tail_ms,
-- default 2000) is only ever billed by close_studio_session() — the
-- rarely-used admin "Force release"/"End session" RPC. Its own migration
-- comment (20260810250000_close_studio_session_floor_tail.sql:4-9) claims
-- pause_studio_session() and reap_orphaned_studio_sessions() "already"
-- apply a teardown tail — that claim was never actually true of either
-- function's current definition (verified directly against
-- 20260717045300 and 20260716154252, the latest version of each; neither
-- references teardown_tail_ms at all). decart-credit-reconciler's own
-- code comment makes the identical incorrect assumption, which is exactly
-- why its inferred_untracked_ms health metric never flagged this: it
-- assumes the tail is already folded into `tracked`.
--
-- These two functions close virtually every real session (user-initiated
-- disconnect, and the automatic reaper — which runs every 2s and handles
-- expired/ownership-mismatch/orphaned/exhausted closes). Brought in line
-- with close_studio_session()'s exact computation: floor first, then add
-- the tail, then cap at whatever balance the session actually had.

-- 1) pause_studio_session — user-initiated disconnect.
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
  v_floor bigint;
  v_remaining bigint;
  v_will_deactivate boolean := false;
  v_min_bill bigint;
  v_warmup_ms bigint;
  v_tail_ms bigint;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;

  SELECT COALESCE(handshake_floor_ms, 8000),
         COALESCE(warmup_grace_ms, 30000),
         COALESCE(teardown_tail_ms, 2000)
    INTO v_min_bill, v_warmup_ms, v_tail_ms
    FROM public.studio_pricing_config LIMIT 1;
  IF v_min_bill IS NULL THEN v_min_bill := 8000; END IF;
  IF v_warmup_ms IS NULL THEN v_warmup_ms := 30000; END IF;
  IF v_tail_ms IS NULL THEN v_tail_ms := 2000; END IF;

  SELECT * INTO v_row FROM public.api_keys
   WHERE key = trim(p_key) AND user_id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found_or_not_owner');
  END IF;

  IF v_row.active_session_id IS DISTINCT FROM p_session_id THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'lock_not_held');
  END IF;

  SELECT s.started_at,
         s.first_heartbeat_at,
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
    -- Smart floor: if the SDK never warmed up AND the session is younger than
    -- warmup_grace_ms, charge only the handshake floor (a true "connect fizzle").
    -- Otherwise charge at least the warmup floor — the SDK burned real Decart
    -- time even if the user tapped pause before any heartbeat landed. Either
    -- way, add the teardown tail — the Decart connection doesn't vanish the
    -- instant we decide to stop billing.
    IF v_session.first_heartbeat_at IS NULL AND v_elapsed < v_warmup_ms THEN
      v_floor := v_session.min_bill;
    ELSE
      v_floor := GREATEST(v_session.min_bill, v_warmup_ms);
    END IF;
    v_bill := GREATEST(v_elapsed, v_floor) + v_tail_ms;
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
   WHERE id = v_row.id;

  IF v_session.started_at IS NOT NULL THEN
    UPDATE public.studio_sessions
       SET ended_at = now(),
           end_reason = 'user_pause',
           remaining_ms_at_end = COALESCE(v_remaining, remaining_ms_at_end),
           duration_ms = v_bill,
           last_debit_at = now()
     WHERE session_id = p_session_id AND ended_at IS NULL;
  END IF;

  RETURN jsonb_build_object('ok', true, 'remaining_ms', v_remaining, 'billed_ms', v_bill);
END;
$function$;

-- 2) reap_orphaned_studio_sessions — the automatic reaper (every 2s),
--    handles expired/ownership-mismatch/orphaned/exhausted closes.
CREATE OR REPLACE FUNCTION public.reap_orphaned_studio_sessions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  v_warmup_ms bigint;
  v_warmup_interval interval;
  v_tail_ms bigint;
  v_close boolean;
  v_reason text;
  v_effective_remaining bigint;
  v_session_age_ms bigint;
  v_bill_floor bigint;
BEGIN
  IF NOT pg_try_advisory_lock(hashtext('reap_studio_sessions')) THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(handshake_floor_ms, 8000),
         COALESCE(hard_stale_ms, 90000),
         COALESCE(warmup_grace_ms, 30000),
         COALESCE(teardown_tail_ms, 2000)
    INTO v_min_bill, v_hard_stale_ms, v_warmup_ms, v_tail_ms
    FROM public.studio_pricing_config LIMIT 1;
  IF v_min_bill IS NULL THEN v_min_bill := 8000; END IF;
  IF v_hard_stale_ms IS NULL THEN v_hard_stale_ms := 90000; END IF;
  IF v_warmup_ms IS NULL THEN v_warmup_ms := 30000; END IF;
  IF v_tail_ms IS NULL THEN v_tail_ms := 2000; END IF;
  v_hard_stale_interval := make_interval(secs => v_hard_stale_ms::double precision / 1000.0);
  v_warmup_interval := make_interval(secs => v_warmup_ms::double precision / 1000.0);

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
    v_session_age_ms := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - r.started_at)) * 1000)::bigint);
    v_delta := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - COALESCE(r.last_debit_at, r.started_at))) * 1000)::bigint);
    v_effective_remaining := r.key_remaining_ms;

    IF r.remaining_ms_at_start IS NULL AND r.key_remaining_ms IS NULL THEN
      v_new_key_remaining := NULL;
    ELSE
      IF v_effective_remaining IS NULL THEN
        v_new_key_remaining := GREATEST(0, COALESCE(r.remaining_ms_at_start, 0) - v_delta);
      ELSE
        v_new_key_remaining := GREATEST(0, v_effective_remaining - v_delta);
      END IF;
    END IF;

    v_close := false;
    v_reason := NULL;

    IF r.key_expires_at IS NOT NULL AND r.key_expires_at <= now() THEN
      v_close := true;
      v_reason := 'expired';
    ELSIF r.key_user_id IS DISTINCT FROM r.user_id THEN
      v_close := true;
      v_reason := 'ownership_mismatch_reap';
    ELSIF r.key_active_session IS DISTINCT FROM r.session_id THEN
      -- GRACE: only fire this branch if the session is older than warmup_grace_ms.
      -- Below the grace window, a mismatch is almost certainly a mint/reconnect race —
      -- leave the row live so heartbeats can still land.
      IF v_session_age_ms >= v_warmup_ms THEN
        v_close := true;
        v_reason := 'orphaned_auto';
      END IF;
    ELSIF v_new_key_remaining IS NOT NULL AND v_new_key_remaining <= 0 THEN
      v_close := true;
      v_reason := 'exhausted';
    ELSIF r.last_heartbeat_at < now() - v_hard_stale_interval THEN
      v_close := true;
      v_reason := 'orphaned_auto';
    END IF;

    v_end_ts := now();
    IF v_close AND r.key_expires_at IS NOT NULL AND r.key_expires_at < v_end_ts AND v_reason = 'expired' THEN
      v_end_ts := r.key_expires_at;
    END IF;

    v_duration := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (v_end_ts - r.started_at)) * 1000)::bigint);

    IF v_close THEN
      -- Smart bill floor, same as pause_studio_session, plus the teardown
      -- tail — the Decart connection doesn't vanish the instant we decide
      -- to stop billing, regardless of which reason triggered the close.
      IF r.first_heartbeat_at IS NULL AND v_session_age_ms < v_warmup_ms THEN
        v_bill_floor := v_min_bill;
      ELSE
        v_bill_floor := GREATEST(v_min_bill, v_warmup_ms);
      END IF;

      v_duration := GREATEST(v_duration, v_bill_floor) + v_tail_ms;
      IF r.remaining_ms_at_start IS NOT NULL THEN
        v_duration := LEAST(v_duration, r.remaining_ms_at_start);
      END IF;

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

    IF r.key_active_session = r.session_id AND r.key_user_id = r.user_id THEN
      IF v_close THEN
        -- On close, apply the ACTUAL billed duration (not raw delta) to remaining_ms
        -- so the floor+tail charge lands on the key.
        DECLARE v_final_remaining bigint;
        BEGIN
          IF r.remaining_ms_at_start IS NOT NULL THEN
            v_final_remaining := GREATEST(0, r.remaining_ms_at_start - v_duration);
          ELSE
            v_final_remaining := v_new_key_remaining;
          END IF;

          UPDATE public.api_keys
             SET active_session_id = NULL,
                 active_session_started_at = NULL,
                 last_session_ended_at = now(),
                 remaining_ms = CASE
                   WHEN v_final_remaining IS NULL THEN remaining_ms
                   WHEN remaining_ms IS NULL THEN v_final_remaining
                   ELSE LEAST(remaining_ms, v_final_remaining)
                 END,
                 expires_at = NULL,
                 is_active = CASE WHEN v_final_remaining IS NOT NULL AND v_final_remaining <= 0 THEN false ELSE is_active END
           WHERE id = r.api_key_id
             AND user_id = r.user_id;
        END;
      ELSE
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
$$;

-- 3) Correct the reconciler's now-accurate comment: the tail IS folded into
--    `tracked` as of this migration (it wasn't before).
COMMENT ON FUNCTION public.reap_orphaned_studio_sessions() IS
  'Bills floor + teardown_tail_ms on close (all reasons). See 20260815240000.';
