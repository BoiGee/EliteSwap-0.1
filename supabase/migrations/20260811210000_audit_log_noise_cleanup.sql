-- Audit tab audit found the log had grown to 22,697 rows in one week
-- (created 2026-08-04), of which 22,244 (98%) were api_keys.update entries
-- whose ONLY changed columns were the routine studio-session heartbeat
-- fields (remaining_ms, expires_at, active_session_id,
-- active_session_started_at, last_session_ended_at,
-- mint_attempts_window_start, mint_attempts_in_window) — ticking roughly
-- every 1-2 seconds during an active studio session. The generic
-- audit_row_change() trigger on api_keys captures a full before/after
-- JSONB snapshot of the entire row (including the raw key value) on every
-- single one of these, burying the ~450 rows that were actual admin/
-- security-relevant events under a wall of countdown-timer noise, and
-- defeating the tab's purpose as a reviewable admin action log. Verified
-- this wasn't blanket-deletable: a 370-row cluster at one exact timestamp
-- (2026-08-10T16:25:54) turned out to be the real, meaningful Decart-key
-- short-format migration (key column itself changing from raw pool keys
-- to short codes) — that's exactly the kind of event an audit log should
-- keep, so the fix targets column names specifically rather than volume
-- or actor.

-- Rebuilt from the CURRENT live definition (20260704195727, which already
-- fixed a same-day bug in the original 20260704163848 version: direct
-- OLD.status/NEW.status field access on the polymorphic record-typed
-- OLD/NEW breaks for every non-payments table with "record OLD has no
-- field status" — reproduced live while testing this exact migration, a
-- reminder to diff against the live function, not the first migration
-- that created it). The only change from that live version is the new
-- api_keys routine-column skip below.
CREATE OR REPLACE FUNCTION public.audit_row_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target TEXT;
  tid TEXT;
  action_name TEXT;
  before_j JSONB;
  after_j JSONB;
  old_status TEXT;
  new_status TEXT;
  has_meaningful_change BOOLEAN;
BEGIN
  target := TG_TABLE_NAME;
  IF TG_OP = 'INSERT' THEN
    action_name := target || '.create';
    before_j := NULL;
    after_j := to_jsonb(NEW);
    tid := COALESCE((to_jsonb(NEW)->>'id'), NULL);
  ELSIF TG_OP = 'UPDATE' THEN
    IF target = 'api_keys' THEN
      SELECT EXISTS (
        SELECT 1 FROM jsonb_each(to_jsonb(NEW)) AS n(key, value)
        JOIN jsonb_each(to_jsonb(OLD)) AS o(key, value) USING (key)
        WHERE n.value IS DISTINCT FROM o.value
          AND n.key != ALL (ARRAY[
            'remaining_ms', 'expires_at', 'active_session_id',
            'active_session_started_at', 'last_session_ended_at',
            'mint_attempts_window_start', 'mint_attempts_in_window'
          ])
      ) INTO has_meaningful_change;

      IF NOT has_meaningful_change THEN
        RETURN NEW;
      END IF;
    END IF;

    action_name := target || '.update';
    before_j := to_jsonb(OLD);
    after_j := to_jsonb(NEW);
    tid := COALESCE((to_jsonb(NEW)->>'id'), NULL);
    IF target = 'payments' THEN
      old_status := before_j->>'status';
      new_status := after_j->>'status';
      IF old_status IS DISTINCT FROM new_status AND new_status IS NOT NULL THEN
        action_name := 'payments.status.' || new_status;
      END IF;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    action_name := target || '.delete';
    before_j := to_jsonb(OLD);
    after_j := NULL;
    tid := COALESCE((to_jsonb(OLD)->>'id'), NULL);
  END IF;

  PERFORM public.log_admin_action(action_name, target, tid, before_j, after_j, '{}'::jsonb);

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

-- One-time cleanup: remove the historical routine-only noise using the
-- same rule the trigger now applies going forward.
DELETE FROM public.admin_audit_logs
WHERE action = 'api_keys.update'
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_each(after_data) AS n(key, value)
    JOIN jsonb_each(before_data) AS o(key, value) USING (key)
    WHERE n.value IS DISTINCT FROM o.value
      AND n.key != ALL (ARRAY[
        'remaining_ms', 'expires_at', 'active_session_id',
        'active_session_started_at', 'last_session_ended_at',
        'mint_attempts_window_start', 'mint_attempts_in_window'
      ])
  );
