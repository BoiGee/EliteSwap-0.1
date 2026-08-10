
-- 1. Marker table so reconciliations are idempotent
CREATE TABLE IF NOT EXISTS public.studio_session_reconciliations (
  session_id uuid PRIMARY KEY REFERENCES public.studio_sessions(id) ON DELETE CASCADE,
  debited_ms bigint NOT NULL DEFAULT 0,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.studio_session_reconciliations TO authenticated;
GRANT ALL ON public.studio_session_reconciliations TO service_role;

ALTER TABLE public.studio_session_reconciliations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read reconciliations"
  ON public.studio_session_reconciliations FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

-- 2. Reconciliation pass (paid keys → debit; trial keys → log only)
DO $$
DECLARE
  v_total_ms bigint := 0;
  v_keys_affected int := 0;
  v_paid_sessions int := 0;
  v_trial_sessions int := 0;
BEGIN
  PERFORM set_config('app.bypass_key_guard', 'on', true);

  -- Paid sessions: debit the floor deficit
  WITH candidates AS (
    SELECT s.id AS session_id,
           s.api_key_id,
           GREATEST(0, 30000 - COALESCE(s.duration_ms, 0))::bigint AS deficit_ms
      FROM public.studio_sessions s
     WHERE s.started_at >= now() - interval '90 days'
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
    RETURNING k.id, c.deficit_ms
  ),
  bump_sessions AS (
    UPDATE public.studio_sessions s
       SET duration_ms = 30000
     WHERE s.id IN (SELECT session_id FROM candidates)
    RETURNING s.id
  ),
  markers AS (
    INSERT INTO public.studio_session_reconciliations(session_id, debited_ms, reason)
    SELECT session_id, deficit_ms, 'handshake_floor_backfill_90d'
      FROM candidates
    ON CONFLICT (session_id) DO NOTHING
    RETURNING session_id, debited_ms
  )
  SELECT COALESCE(SUM(debited_ms), 0),
         (SELECT COUNT(*) FROM debits),
         (SELECT COUNT(*) FROM markers)
    INTO v_total_ms, v_keys_affected, v_paid_sessions
    FROM markers;

  -- Trial sessions: paper trail only
  WITH trial_candidates AS (
    SELECT s.id AS session_id
      FROM public.studio_sessions s
     WHERE s.started_at >= now() - interval '90 days'
       AND COALESCE(s.is_trial, false) = true
       AND COALESCE(s.duration_ms, 0) < 30000
       AND NOT EXISTS (
         SELECT 1 FROM public.studio_session_reconciliations r WHERE r.session_id = s.id
       )
  ),
  trial_markers AS (
    INSERT INTO public.studio_session_reconciliations(session_id, debited_ms, reason)
    SELECT session_id, 0, 'trial_uncollectable_logged'
      FROM trial_candidates
    ON CONFLICT (session_id) DO NOTHING
    RETURNING session_id
  )
  SELECT COUNT(*) INTO v_trial_sessions FROM trial_markers;

  -- Summary audit log
  INSERT INTO public.admin_audit_logs(
    actor_id, action, target_type, target_id, metadata
  ) VALUES (
    NULL,
    'studio_time_reconciliation_90d',
    'studio_sessions',
    NULL,
    jsonb_build_object(
      'paid_sessions_reconciled', v_paid_sessions,
      'trial_sessions_logged', v_trial_sessions,
      'keys_affected', v_keys_affected,
      'total_ms_reclaimed', v_total_ms,
      'total_seconds_reclaimed', ROUND(v_total_ms::numeric / 1000, 1),
      'decart_credits_reclaimed', ROUND(v_total_ms::numeric / 1000 * 2.083, 0)
    )
  );
END $$;

-- 3. Tighten pause_studio_session to use the same smart bill floor
--    (warmup_grace_ms once the SDK has warmed up) as the reaper / takeover paths.
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
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;

  SELECT COALESCE(handshake_floor_ms, 8000),
         COALESCE(warmup_grace_ms, 30000)
    INTO v_min_bill, v_warmup_ms
    FROM public.studio_pricing_config LIMIT 1;
  IF v_min_bill IS NULL THEN v_min_bill := 8000; END IF;
  IF v_warmup_ms IS NULL THEN v_warmup_ms := 30000; END IF;

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
    -- time even if the user tapped pause before any heartbeat landed.
    IF v_session.first_heartbeat_at IS NULL AND v_elapsed < v_warmup_ms THEN
      v_floor := v_session.min_bill;
    ELSE
      v_floor := GREATEST(v_session.min_bill, v_warmup_ms);
    END IF;
    v_bill := GREATEST(v_elapsed, v_floor);
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
