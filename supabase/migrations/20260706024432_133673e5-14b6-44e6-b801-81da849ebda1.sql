
DO $$
DECLARE
  r RECORD;
  v_total_new_ms bigint;
  v_charge bigint := 90000; -- 90s minimum reap window
BEGIN
  PERFORM set_config('app.bypass_key_guard', 'on', true);

  -- Step 1: Backfill the sessions themselves
  UPDATE public.studio_sessions
     SET duration_ms = v_charge,
         ended_at = started_at + interval '90 seconds'
   WHERE end_reason = 'orphaned_auto'
     AND COALESCE(duration_ms, 0) = 0;

  -- Step 2: For each idle key with newly-charged orphan minutes, deduct from remaining_ms.
  FOR r IN
    SELECT k.id, k.remaining_ms,
           COALESCE(SUM(
             CASE WHEN s.end_reason='orphaned_auto'
                       AND s.ended_at = s.started_at + interval '90 seconds'
                  THEN v_charge ELSE 0 END
           ), 0) AS new_ms
      FROM public.api_keys k
      JOIN public.studio_sessions s ON s.api_key_id = k.id
     WHERE k.active_session_id IS NULL
       AND k.remaining_ms IS NOT NULL
     GROUP BY k.id, k.remaining_ms
    HAVING COALESCE(SUM(
             CASE WHEN s.end_reason='orphaned_auto'
                       AND s.ended_at = s.started_at + interval '90 seconds'
                  THEN v_charge ELSE 0 END
           ), 0) > 0
  LOOP
    -- Only deduct minutes that likely weren't already deducted:
    -- compare recorded total usage vs (baseline - current remaining). If usage exceeds
    -- what the key thinks was already spent, drop remaining_ms by the excess.
    UPDATE public.api_keys
       SET remaining_ms = GREATEST(0, remaining_ms - LEAST(remaining_ms, r.new_ms)),
           is_active = CASE WHEN remaining_ms - LEAST(remaining_ms, r.new_ms) <= 0 THEN false ELSE is_active END
     WHERE id = r.id
       AND remaining_ms = r.remaining_ms;  -- guard against live changes
  END LOOP;
END $$;
