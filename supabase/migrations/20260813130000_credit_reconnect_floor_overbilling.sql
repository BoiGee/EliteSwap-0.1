-- One-time credit for real over-billing caused by the reconnect "smart bill
-- floor" (pause_studio_session, supabase/migrations/20260717045300_...sql:
-- 178-183): it charges a flat ~30s minimum any time a heartbeat has landed,
-- even when the session's real wall-clock duration was much shorter. During
-- a burst of rapid reconnects (e.g. a flaky connection retrying every few
-- seconds) this compounds fast — one reported user burned ~17 real minutes
-- of balance across ~20 reconnects in 25 minutes, most of which were only
-- 12-30 real seconds long.
--
-- Confirmed this is not isolated: comparing studio_sessions.duration_ms
-- against real elapsed time (ended_at - started_at) over the last 14 days
-- turned up 174 sessions across 39 distinct keys, ~58 minutes total
-- over-billed. This migration credits exactly that difference back to each
-- affected key's remaining_ms. The floor policy itself is intentionally
-- left unchanged here — this is a one-time make-good, not a billing logic
-- change.
--
-- Untimed keys (remaining_ms IS NULL, i.e. no countdown) are excluded —
-- there's no balance to credit and nothing to reactivate.
DO $credit$
DECLARE
  v_total_credited bigint := 0;
  v_keys_credited integer := 0;
BEGIN
  PERFORM set_config('app.bypass_key_guard', 'on', true);

  WITH overbilled AS (
    SELECT api_key_id,
           sum(duration_ms - GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000))::bigint) AS credit_ms
      FROM public.studio_sessions
     WHERE ended_at IS NOT NULL
       AND started_at >= now() - interval '14 days'
       AND duration_ms > 0
       AND EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000 < duration_ms - 5000
     GROUP BY api_key_id
  ),
  applied AS (
    UPDATE public.api_keys k
       SET remaining_ms = k.remaining_ms + o.credit_ms,
           is_active = CASE WHEN k.remaining_ms + o.credit_ms > 0 THEN true ELSE k.is_active END
      FROM overbilled o
     WHERE k.id = o.api_key_id
       AND k.remaining_ms IS NOT NULL
       AND o.credit_ms > 0
     RETURNING k.id, o.credit_ms
  )
  SELECT count(*), COALESCE(sum(credit_ms), 0) INTO v_keys_credited, v_total_credited FROM applied;

  RAISE NOTICE 'Credited % ms across % keys for reconnect-floor over-billing', v_total_credited, v_keys_credited;
END;
$credit$;
