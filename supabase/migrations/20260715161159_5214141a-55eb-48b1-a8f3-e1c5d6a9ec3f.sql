
DO $$
DECLARE
  v_hard_cap_ms bigint := 10 * 60 * 1000;
  v_row record;
BEGIN
  PERFORM set_config('app.bypass_key_guard', 'on', true);

  FOR v_row IN
    WITH per_session AS (
      SELECT
        s.api_key_id,
        GREATEST(
          0,
          (EXTRACT(EPOCH FROM (COALESCE(s.ended_at, s.last_heartbeat_at) - s.started_at)) * 1000)::bigint
          - (s.remaining_ms_at_start - COALESCE(s.remaining_ms_at_end, s.remaining_ms_at_start))
        ) AS undercharge_ms
      FROM public.studio_sessions s
      WHERE s.started_at > now() - interval '30 days'
        AND s.remaining_ms_at_start IS NOT NULL
        AND (s.ended_at IS NOT NULL OR s.last_heartbeat_at > now() - interval '24 hours')
    ),
    per_key AS (
      SELECT api_key_id, COUNT(*) AS sessions_counted, SUM(undercharge_ms) AS total_undercharge_ms
      FROM per_session
      WHERE api_key_id IS NOT NULL
      GROUP BY api_key_id
    )
    SELECT
      k.id AS api_key_id,
      k.remaining_ms AS prior_remaining_ms,
      LEAST(p.total_undercharge_ms, v_hard_cap_ms, k.remaining_ms) AS debit_ms,
      p.sessions_counted
    FROM per_key p
    JOIN public.api_keys k ON k.id = p.api_key_id
    WHERE k.remaining_ms > 0
      AND k.active_session_id IS NULL
      AND p.total_undercharge_ms > 0
  LOOP
    IF v_row.debit_ms <= 0 THEN CONTINUE; END IF;

    UPDATE public.api_keys
    SET remaining_ms = GREATEST(0, remaining_ms - v_row.debit_ms)
    WHERE id = v_row.api_key_id;

    INSERT INTO public.admin_audit_logs (actor_id, action, target_type, target_id, metadata)
    VALUES (
      NULL,
      'studio_time_reconciliation',
      'api_key',
      v_row.api_key_id,
      jsonb_build_object(
        'sessions_counted',   v_row.sessions_counted,
        'debited_ms',         v_row.debit_ms,
        'prior_remaining_ms', v_row.prior_remaining_ms,
        'new_remaining_ms',   GREATEST(0, v_row.prior_remaining_ms - v_row.debit_ms),
        'hard_cap_ms',        v_hard_cap_ms,
        'window',             '30 days'
      )
    );
  END LOOP;
END $$;
