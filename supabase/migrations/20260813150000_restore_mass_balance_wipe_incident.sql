-- Restores 777 api_keys rows hit by a single, un-tracked bulk operation at
-- 2026-08-12 17:34:07.240393 UTC that set remaining_ms = 0 and
-- is_active = false across all of them simultaneously (confirmed via the
-- audit trigger's before/after row snapshots: same statement timestamp on
-- every row, all transitioning healthy-balance/active -> zero/inactive in
-- one shot). Total wiped: 276,148,717ms (~76.7 hours) of paid customer
-- time. The exact query responsible was not run through a tracked
-- migration, so the root cause (almost certainly an over-broad manual
-- cleanup query run around the same time as the trial-key-duplication
-- incident fixed by 20260812180000_fix_trial_key_recursion_bug.sql, which
-- itself does not touch remaining_ms) could not be identified from schema
-- alone.
--
-- Restoration uses the audit log's exact before_data snapshot per key —
-- not an estimate. Added to (not replacing) each key's current remaining_ms
-- so this composes correctly with the reconnect-floor-overbilling credit
-- already applied by 20260813130000 to a subset of these same keys: for
-- keys that got that credit, current remaining_ms already equals
-- 0 + floor_credit, so adding the pre-wipe balance yields
-- floor_credit + pre_wipe_balance (correct, additive, not double-counted).
-- For keys that didn't get that credit, current remaining_ms is still
-- exactly 0 (these keys were is_active=false the whole time since the
-- wipe, so nothing could have legitimately consumed further balance),
-- so the result is just the restored pre-wipe balance.
DO $restore$
DECLARE
  v_keys_restored integer := 0;
  v_total_restored bigint := 0;
BEGIN
  PERFORM set_config('app.bypass_key_guard', 'on', true);

  WITH incident AS (
    SELECT (a.target_id)::uuid AS api_key_id,
           COALESCE((a.before_data->>'remaining_ms')::bigint, 0) AS pre_wipe_remaining_ms
      FROM public.admin_audit_logs a
     WHERE a.target_type = 'api_keys'
       AND a.created_at = '2026-08-12 17:34:07.240393+00'
  ),
  applied AS (
    UPDATE public.api_keys k
       SET remaining_ms = COALESCE(k.remaining_ms, 0) + i.pre_wipe_remaining_ms,
           is_active = true,
           expires_at = NULL,
           active_session_id = NULL,
           active_session_started_at = NULL
      FROM incident i
     WHERE k.id = i.api_key_id
     RETURNING k.id, i.pre_wipe_remaining_ms
  )
  SELECT count(*), COALESCE(sum(pre_wipe_remaining_ms), 0) INTO v_keys_restored, v_total_restored FROM applied;

  RAISE NOTICE 'Restored % ms across % keys from the 2026-08-12 17:34:07 mass balance wipe', v_total_restored, v_keys_restored;
END;
$restore$;
