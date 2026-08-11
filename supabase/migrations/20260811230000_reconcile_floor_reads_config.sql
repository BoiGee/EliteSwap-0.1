-- reconcile_studio_session_floors() hardcoded its 30-second backfill floor
-- directly in SQL instead of reading studio_pricing_config.warmup_grace_ms
-- (the same knob every other billing function in this family — start/
-- heartbeat/pause/close_studio_session, reap_orphaned_studio_sessions —
-- reads live). Tuning warmup_grace_ms would silently stop propagating to
-- this one 10-minute reconciliation backstop, which would keep backfilling
-- against a stale 30000 forever. Parameterized it the same way as its
-- siblings: COALESCE(warmup_grace_ms, 30000) read once per run.

CREATE OR REPLACE FUNCTION public.reconcile_studio_session_floors()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
  v_floor_ms bigint;
BEGIN
  IF NOT pg_try_advisory_lock(hashtext('reconcile_studio_session_floors')) THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(warmup_grace_ms, 30000) INTO v_floor_ms
    FROM public.studio_pricing_config LIMIT 1;
  IF v_floor_ms IS NULL THEN v_floor_ms := 30000; END IF;

  PERFORM set_config('app.bypass_key_guard', 'on', true);

  -- Paid sessions: debit the floor deficit against the key, bump duration_ms.
  WITH candidates AS (
    SELECT s.id AS session_id,
           s.api_key_id,
           GREATEST(0, v_floor_ms - COALESCE(s.duration_ms, 0))::bigint AS deficit_ms
      FROM public.studio_sessions s
     WHERE s.ended_at IS NOT NULL
       AND s.started_at >= now() - interval '7 days'
       AND COALESCE(s.is_trial, false) = false
       AND COALESCE(s.duration_ms, 0) < v_floor_ms
       AND s.api_key_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.studio_session_reconciliations r WHERE r.session_id = s.id
       )
  ),
  debits AS (
    UPDATE public.api_keys k
       SET remaining_ms = GREATEST(0, COALESCE(k.remaining_ms, 0) - c.deficit_ms),
           expires_at = CASE
             WHEN k.expires_at IS NULL THEN NULL
             ELSE now() + (GREATEST(0, COALESCE(k.remaining_ms, 0) - c.deficit_ms) || ' milliseconds')::interval
           END
      FROM (
        SELECT api_key_id, SUM(deficit_ms) AS deficit_ms
          FROM candidates
         GROUP BY api_key_id
      ) c
     WHERE k.id = c.api_key_id
    RETURNING k.id
  ),
  bump_sessions AS (
    UPDATE public.studio_sessions s
       SET duration_ms = v_floor_ms
     WHERE s.id IN (SELECT session_id FROM candidates)
    RETURNING s.id
  ),
  markers AS (
    INSERT INTO public.studio_session_reconciliations(session_id, debited_ms, reason)
    SELECT session_id, deficit_ms, 'handshake_floor_backfill_recurring'
      FROM candidates
    ON CONFLICT (session_id) DO NOTHING
    RETURNING session_id
  )
  SELECT COUNT(*) INTO v_count FROM markers;

  -- Trial sessions below the floor: paper trail only — nothing left to debit
  -- on an already-exhausted trial key.
  INSERT INTO public.studio_session_reconciliations(session_id, debited_ms, reason)
  SELECT s.id, 0, 'trial_uncollectable_logged'
    FROM public.studio_sessions s
   WHERE s.ended_at IS NOT NULL
     AND s.started_at >= now() - interval '7 days'
     AND COALESCE(s.is_trial, false) = true
     AND COALESCE(s.duration_ms, 0) < v_floor_ms
     AND NOT EXISTS (
       SELECT 1 FROM public.studio_session_reconciliations r WHERE r.session_id = s.id
     )
  ON CONFLICT (session_id) DO NOTHING;

  PERFORM pg_advisory_unlock(hashtext('reconcile_studio_session_floors'));
  RETURN v_count;
END;
$$;
