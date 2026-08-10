
-- 1) Fix the reaper so a locked key without heartbeats still burns wall-clock time.
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
  v_end_ts timestamptz;
  v_duration bigint;
  v_no_real_hb boolean;
BEGIN
  PERFORM set_config('app.bypass_key_guard', 'on', true);

  FOR r IN
    SELECT s.*, k.expires_at AS key_expires_at, k.remaining_ms AS key_remaining_ms, k.active_session_id AS key_active_session
    FROM public.studio_sessions s
    LEFT JOIN public.api_keys k ON k.id = s.api_key_id
    WHERE s.ended_at IS NULL
      AND (
        s.last_heartbeat_at < now() - interval '90 seconds'
        OR (k.expires_at IS NOT NULL AND k.expires_at <= now())
        OR k.active_session_id IS DISTINCT FROM s.session_id
      )
  LOOP
    -- Detect "no real heartbeat ever landed" (only the row-insert stamp)
    v_no_real_hb := r.last_heartbeat_at <= r.started_at + interval '3 seconds';

    -- End timestamp:
    --   * no-HB path -> charge wall-clock until now() (the key was locked the whole time)
    --   * normal     -> last observed heartbeat
    v_end_ts := CASE
      WHEN v_no_real_hb THEN now()
      ELSE COALESCE(r.last_heartbeat_at, r.started_at)
    END;

    -- Never charge past key expiry
    IF r.key_expires_at IS NOT NULL AND r.key_expires_at < v_end_ts THEN
      v_end_ts := r.key_expires_at;
    END IF;

    v_duration := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (v_end_ts - r.started_at)) * 1000)::bigint);

    IF r.remaining_ms_at_start IS NOT NULL THEN
      v_duration := LEAST(v_duration, r.remaining_ms_at_start);
      v_remaining := GREATEST(0, r.remaining_ms_at_start - v_duration);
    ELSIF r.key_expires_at IS NOT NULL THEN
      v_remaining := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (r.key_expires_at - now())) * 1000)::bigint);
    ELSE
      v_remaining := r.key_remaining_ms;
    END IF;

    UPDATE public.studio_sessions
       SET ended_at = v_end_ts,
           end_reason = CASE
             WHEN r.key_expires_at IS NOT NULL AND r.key_expires_at <= now() THEN 'expired'
             ELSE 'orphaned_auto'
           END,
           remaining_ms_at_end = v_remaining,
           duration_ms = v_duration
     WHERE id = r.id;

    IF r.key_active_session = r.session_id THEN
      UPDATE public.api_keys
         SET active_session_id = NULL,
             active_session_started_at = NULL,
             last_session_ended_at = now(),
             remaining_ms = v_remaining,
             expires_at = NULL,
             is_active = CASE WHEN v_remaining <= 0 THEN false ELSE is_active END
       WHERE id = r.api_key_id;
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$;

-- 2) Backfill: recompute duration_ms for past zero-duration orphans using wall-clock
--    (ended_at - started_at). ended_at is when the reaper closed the row, so this
--    represents the true time the key was locked.
UPDATE public.studio_sessions
   SET duration_ms = GREATEST(
        0,
        FLOOR(EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000)::bigint
   )
 WHERE end_reason = 'orphaned_auto'
   AND ended_at IS NOT NULL
   AND COALESCE(duration_ms, 0) = 0
   AND ended_at > started_at;

-- 3) Rebuild remaining_ms on idle keys so their balance reflects the recomputed usage.
--    Only touch keys with no active session to avoid stepping on live sessions.
DO $$
DECLARE
  r RECORD;
  v_used bigint;
  v_baseline bigint;
BEGIN
  PERFORM set_config('app.bypass_key_guard', 'on', true);

  FOR r IN
    SELECT k.id, k.remaining_ms, k.label
      FROM public.api_keys k
     WHERE k.active_session_id IS NULL
       AND k.remaining_ms IS NOT NULL
  LOOP
    -- Sum recorded durations for this key
    SELECT COALESCE(SUM(
      CASE
        WHEN COALESCE(s.duration_ms, 0) > 0 THEN s.duration_ms
        ELSE 0
      END
    ), 0)
      INTO v_used
      FROM public.studio_sessions s
     WHERE s.api_key_id = r.id;

    -- Baseline = current remaining + used-so-far (before recompute).
    -- We add back the delta between newly-computed usage and what was already deducted.
    -- Concretely: keys whose recorded usage now exceeds original grant need remaining reduced.
    -- Use max(current remaining, session-implied balance) so we never accidentally refund.
    -- Since we can't reliably know the original grant here, we just clamp: if summed
    -- usage exceeds what the key thinks was used (original - remaining), deduct the extra.
    -- For trial keys we know original = 240000ms (4 min from $10 plan / trial).
    IF r.label ILIKE '%trial%' THEN
      v_baseline := 240000;
      IF v_used > (v_baseline - r.remaining_ms) THEN
        UPDATE public.api_keys
           SET remaining_ms = GREATEST(0, v_baseline - v_used),
               is_active = CASE WHEN (v_baseline - v_used) <= 0 THEN false ELSE is_active END
         WHERE id = r.id;
      END IF;
    ELSE
      -- Paid keys: we don't have a fixed baseline in this table, so deduct only the
      -- newly-added orphan duration since last reconciliation. Compute the excess
      -- between summed sessions and (assumed) prior deductions by looking at the
      -- delta introduced by this migration only (zero-duration orphans just fixed).
      DECLARE
        v_new_deduction bigint;
      BEGIN
        SELECT COALESCE(SUM(GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (s.ended_at - s.started_at)) * 1000)::bigint)), 0)
          INTO v_new_deduction
          FROM public.studio_sessions s
         WHERE s.api_key_id = r.id
           AND s.end_reason = 'orphaned_auto'
           AND s.ended_at IS NOT NULL
           AND s.ended_at > s.started_at
           -- Only orphans that were previously 0 and just got backfilled in step 2.
           -- We approximate this with sessions whose duration is now equal to wall-clock
           -- and whose last_heartbeat_at is essentially started_at.
           AND s.last_heartbeat_at <= s.started_at + interval '3 seconds';

        IF v_new_deduction > 0 THEN
          UPDATE public.api_keys
             SET remaining_ms = GREATEST(0, r.remaining_ms - v_new_deduction),
                 is_active = CASE WHEN (r.remaining_ms - v_new_deduction) <= 0 THEN false ELSE is_active END
           WHERE id = r.id;
        END IF;
      END;
    END IF;
  END LOOP;
END $$;
