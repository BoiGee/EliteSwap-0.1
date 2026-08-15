-- Cleanup for the trial-key recursion incident already patched by
-- 20260812180000_fix_trial_key_recursion_bug.sql (which only dropped the
-- recursive trigger going forward — it never touched the phantom rows that
-- recursion had already created). Confirmed via live inspection
-- (2026-08-13) exactly 3 users still carry excess phantom keys:
--   debraburdett6@gmail.com  232 keys -> keep 2, delete 230
--   ploly1987@gmail.com      232 keys -> keep 7, delete 225
--   enisame11@gmail.com      233 keys -> keep 5, delete 228
-- A 4th user initially flagged by a naive "count > 2" heuristic
-- (frankrllodys@gmail.com, 3 keys) turned out on closer inspection to be a
-- legitimate case, not a bug victim: 2 keys from their original free-trial
-- allocation plus one separate, currently-active $10 trial purchase. Left
-- untouched entirely.
--
-- "Keep" = any key with real usage (a studio_sessions or
-- studio_credential_mints row) OR any key formally recorded in
-- free_trial_assignments for that user (the actual FK-enforced source of
-- truth for legitimate trial-key issuance — trial_purchases.assigned_key_id
-- was tried first and rejected: it references free_trial_keys.id, a
-- completely different id space, not api_keys.id, so comparing it directly
-- against api_keys rows was comparing the wrong columns; the first version
-- of this migration caught its own mistake via a real FK violation and
-- rolled back cleanly before touching any data).
--
-- No FK constraint ties studio_sessions/studio_credential_mints to
-- api_keys (confirmed against information_schema before writing this), so
-- deleting the phantom rows does not touch or cascade into session
-- history — it only removes the never-used duplicate key rows themselves.
DO $cleanup$
DECLARE
  v_deleted integer;
BEGIN
  CREATE TEMP TABLE _trial_dup_affected(user_id uuid) ON COMMIT DROP;
  INSERT INTO _trial_dup_affected VALUES
    ('164b4f6c-ad07-427c-af59-a66081c2094b'),
    ('4fde49cb-a338-4a2d-b832-691b1296c0bd'),
    ('ae02223a-554d-435f-a6d8-5bff35b3dadc');

  CREATE TEMP TABLE _trial_dup_keep(user_id uuid, id uuid) ON COMMIT DROP;

  WITH used_keys AS (
    SELECT DISTINCT api_key_id AS id FROM public.studio_sessions
    UNION
    SELECT DISTINCT api_key_id AS id FROM public.studio_credential_mints
  )
  INSERT INTO _trial_dup_keep
  SELECT DISTINCT k.user_id, k.id
    FROM public.api_keys k
    JOIN _trial_dup_affected a ON a.user_id = k.user_id
   WHERE k.id IN (SELECT id FROM used_keys)
      OR k.id IN (SELECT api_key_record_id FROM public.free_trial_assignments WHERE user_id = k.user_id);

  DELETE FROM public.api_keys
   WHERE user_id IN (SELECT user_id FROM _trial_dup_affected)
     AND id NOT IN (SELECT id FROM _trial_dup_keep);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RAISE NOTICE 'Deleted % duplicate trial-key rows across 3 affected accounts', v_deleted;
END;
$cleanup$;
