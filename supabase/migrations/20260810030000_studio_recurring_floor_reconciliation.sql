
-- 20260717045300 backfilled historical studio_sessions closed under the 30s
-- floor as a ONE-TIME manual pass (reason 'handshake_floor_backfill_90d').
-- It never ran again and nothing scheduled it — despite the table's name,
-- there was no ongoing reconciliation, only a single historical patch.
--
-- All current close paths (heartbeat exhaustion, pause_studio_session, the
-- reaper, and mint/start's takeover branch — see the 20260716154252 /
-- 20260717045300 definitions) already apply the smart bill floor at close
-- time, so no NEW session closed through those paths should end up under
-- 30s. This job is a recurring safety net for anything that closes a
-- session some other way (a future code path, a manual admin action, direct
-- DB access) and slips past that floor logic — it runs continuously instead
-- of requiring another manual migration to notice and patch it.
--
-- Unlike the one-time pass, this is scoped to s.ended_at IS NOT NULL — the
-- original backfill had no such guard, so if it had ever run while a
-- session was still open (duration_ms NULL, which satisfies
-- `COALESCE(duration_ms,0) < 30000`), it would have force-closed the
-- accounting for a still-live session. That gap is closed here.
CREATE OR REPLACE FUNCTION public.reconcile_studio_session_floors()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  IF NOT pg_try_advisory_lock(hashtext('reconcile_studio_session_floors')) THEN
    RETURN 0;
  END IF;

  PERFORM set_config('app.bypass_key_guard', 'on', true);

  -- Paid sessions: debit the floor deficit against the key, bump duration_ms.
  WITH candidates AS (
    SELECT s.id AS session_id,
           s.api_key_id,
           GREATEST(0, 30000 - COALESCE(s.duration_ms, 0))::bigint AS deficit_ms
      FROM public.studio_sessions s
     WHERE s.ended_at IS NOT NULL
       AND s.started_at >= now() - interval '7 days'
       AND COALESCE(s.is_trial, false) = false
       AND COALESCE(s.duration_ms, 0) < 30000
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
       SET duration_ms = 30000
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
     AND COALESCE(s.duration_ms, 0) < 30000
     AND NOT EXISTS (
       SELECT 1 FROM public.studio_session_reconciliations r WHERE r.session_id = s.id
     )
  ON CONFLICT (session_id) DO NOTHING;

  PERFORM pg_advisory_unlock(hashtext('reconcile_studio_session_floors'));
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_studio_session_floors() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reconcile_studio_session_floors() TO service_role;

DO $$
DECLARE
  v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'reconcile-studio-session-floors';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;
  -- pg_cron's bare-string schedule syntax only accepts "N seconds" (verified
  -- against the live extension — 1.6.4 rejected "10 minutes" as invalid);
  -- anything coarser needs standard 5-field cron syntax.
  PERFORM cron.schedule(
    'reconcile-studio-session-floors',
    '*/10 * * * *',
    $cron$SELECT public.reconcile_studio_session_floors();$cron$
  );
END $$;
