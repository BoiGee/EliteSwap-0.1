-- User-reported: (1) new signups aren't registering / adding to the Total
-- Users tally, (2) new $10 payments "aren't recorded", (3) unique 4-minute
-- trial codes aren't generated after a $10 payment succeeds. Verified all
-- three against live data.
--
-- ROOT CAUSE #1 (confirmed, severe): public.auth.users has ZERO triggers on
-- it right now — on_auth_user_created, which is supposed to INSERT a row
-- into public.profiles for every new signup via handle_new_user(), does not
-- exist on this project at all. It's present in the migration history
-- (20260415135526) but never actually landed on this standalone Supabase
-- project (created during the Lovable migration) — apply-schema-resilient's
-- whole design is to continue past individual statement failures, and
-- CREATE TRIGGER ... ON auth.users is exactly the kind of elevated-privilege
-- statement that plausibly failed silently there while everything else
-- succeeded.
--
-- Verified: of the users with created_at after the migration's own
-- 2026-08-10 06:06 UTC bulk-import window, essentially all newer genuine
-- signups (scattered realistic timestamps like 16:47, 20:05, 22:44, 23:35,
-- next-day 02:58 — not the ~0.35s-apart mechanical spacing of the import
-- batch itself) have NO public.profiles row. Admin.tsx's Total Users tile
-- is literally `profiles.length` (Admin.tsx:236) — these users are 100%
-- invisible to it, and to every other admin view keyed off profiles
-- (shows up as a bare user_id instead of an email, e.g. in the $10 Trials
-- list), which is almost certainly why paying customers who signed up
-- during this window look "unrecorded" even though their trial_purchases
-- row is actually fine.
--
-- ROOT CAUSE #2 (confirmed, imminent/real): public.free_trial_keys — the
-- pool assign_trial_key_from_purchase() draws from for both $10 trial
-- purchases and free trial claims — is down to 4 unclaimed keys out of 174
-- ever added, with bursts of 5/day consumption seen recently. The sibling
-- mechanism for the main paid-plan pool (issue_api_key_for_payment) already
-- has a full safety net for exactly this: retry-pending-key-assignments
-- (cron, retries + admin push after 15min stuck). The $10 trial pool has
-- NONE of that. reconcile-trial-purchases/index.ts even has a comment
-- claiming "key fulfillment trigger will catch up when pool refills" — no
-- such trigger exists anywhere in this codebase; verified directly against
-- pg_trigger. When (not if, at this consumption rate) the pool hits zero,
-- assign_trial_key_from_purchase() raises 'No trial keys available', the
-- purchase stays status='confirmed' with assigned_key_id NULL forever, and
-- nothing tells anyone — the only recovery is an admin manually noticing
-- the "Assign key" button in the $10 Trials tab. This is exactly "unique
-- codes... are not generated after $10 payment go through successfully."
--
-- Fixed:
--  1. Restore on_auth_user_created, backfill the missing profiles rows.
--  2. Give free_trial_keys the fulfillment trigger the code already assumes
--     exists: when new keys are added to the pool, automatically clear any
--     backlog of confirmed-but-unassigned purchases, oldest first.
--  3. Add a low-stock admin push the moment the pool crosses 10 remaining
--     (fires once per crossing, mirrors the existing pool_exhausted push
--     pattern) — plus fire it once immediately below since the pool is
--     already at 4 and this has never fired.

-- --- Fix #1: signup -> profile -----------------------------------------

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

INSERT INTO public.profiles (user_id, email)
SELECT u.id, u.email
FROM auth.users u
LEFT JOIN public.profiles p ON p.user_id = u.id
WHERE p.user_id IS NULL;

-- --- Fix #2/#3: trial key pool backlog + low-stock alert -----------------

CREATE OR REPLACE FUNCTION public.assign_trial_key_from_purchase(p_purchase_id uuid)
RETURNS TABLE(api_key_id uuid, api_key text, expires_at timestamp with time zone, duration_ms bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_purchase   public.trial_purchases%ROWTYPE;
  v_pool_key   public.free_trial_keys%ROWTYPE;
  v_new_api_key public.api_keys%ROWTYPE;
  v_duration   bigint;
  v_used_count int;
  v_next_session int;
  v_remaining_before int;
  v_remaining_after int;
  v_low_stock_threshold constant int := 10;
  v_service_key text;
BEGIN
  SELECT * INTO v_purchase FROM public.trial_purchases WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trial purchase % not found', p_purchase_id USING ERRCODE = 'P0002';
  END IF;
  IF v_purchase.status <> 'confirmed' THEN
    RAISE EXCEPTION 'Trial purchase % not confirmed', p_purchase_id USING ERRCODE = '22023';
  END IF;

  IF v_purchase.assigned_key_id IS NOT NULL THEN
    SELECT * INTO v_new_api_key
      FROM public.api_keys
     WHERE pool_key_id = v_purchase.assigned_key_id
       AND user_id = v_purchase.user_id
     ORDER BY created_at DESC
     LIMIT 1;
    IF FOUND THEN
      api_key_id := v_new_api_key.id;
      api_key := v_new_api_key.key;
      expires_at := v_new_api_key.expires_at;
      duration_ms := v_new_api_key.remaining_ms;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  SELECT count(*) INTO v_used_count
    FROM public.trial_purchases
    WHERE user_id = v_purchase.user_id
      AND status = 'confirmed'
      AND assigned_key_id IS NOT NULL;
  IF v_used_count >= 2 THEN
    RAISE EXCEPTION 'Trial limit reached' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO v_remaining_before FROM public.free_trial_keys WHERE claimed_by_user_id IS NULL;

  SELECT * INTO v_pool_key FROM public.free_trial_keys
    WHERE claimed_by_user_id IS NULL
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No trial keys available' USING ERRCODE = 'P0002';
  END IF;

  v_duration := COALESCE(v_pool_key.trial_duration_ms, 240000);

  UPDATE public.free_trial_keys
    SET claimed_by_user_id = v_purchase.user_id,
        claimed_at = now()
    WHERE id = v_pool_key.id;

  -- Low-stock admin alert: fire once, exactly as the pool crosses the
  -- threshold going down, so it never spams and never needs its own
  -- dedupe-state table. Best-effort only — never let a push failure break
  -- a real trial claim.
  v_remaining_after := v_remaining_before - 1;
  IF v_remaining_before > v_low_stock_threshold AND v_remaining_after <= v_low_stock_threshold THEN
    BEGIN
      SELECT decrypted_secret INTO v_service_key
        FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key' LIMIT 1;
      IF v_service_key IS NOT NULL THEN
        PERFORM net.http_post(
          url := 'https://bbxahisheugfryyxfidg.supabase.co/functions/v1/send-admin-push',
          headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_service_key),
          body := jsonb_build_object(
            'event', 'trial_pool_low_stock',
            'title', '$10 trial key pool running low',
            'body', v_remaining_after || ' unclaimed trial key(s) left — top up in Free Trial before purchases start going unfulfilled.',
            'url', '/admin',
            'tag', 'trial-pool-low-stock'
          )
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  -- expires_at intentionally NULL: the 4 minutes only burns down once the
  -- user actually starts a studio session. start_studio_session stamps
  -- expires_at from remaining_ms at session start.
  INSERT INTO public.api_keys (user_id, key, label, is_active, remaining_ms, expires_at, pool_key_id)
    VALUES (
      v_purchase.user_id,
      v_pool_key.api_key,
      'Trial Key',
      true,
      v_duration,
      NULL,
      v_pool_key.id
    )
    RETURNING * INTO v_new_api_key;

  SELECT COALESCE(MAX(session_number), 0) + 1 INTO v_next_session
    FROM public.free_trial_assignments WHERE user_id = v_purchase.user_id;
  IF v_next_session > 2 THEN v_next_session := 2; END IF;

  INSERT INTO public.free_trial_assignments (user_id, free_trial_key_id, api_key_record_id, session_number)
    VALUES (v_purchase.user_id, v_pool_key.id, v_new_api_key.id, v_next_session)
    ON CONFLICT (user_id, session_number) DO NOTHING;

  UPDATE public.trial_purchases
    SET assigned_key_id = v_pool_key.id,
        updated_at = now()
    WHERE id = p_purchase_id;

  api_key_id := v_new_api_key.id;
  api_key := v_new_api_key.key;
  expires_at := v_new_api_key.expires_at;
  duration_ms := v_duration;
  RETURN NEXT;
END;
$function$;

-- The fulfillment mechanism reconcile-trial-purchases already assumes
-- exists ("key fulfillment trigger will catch up when pool refills") but
-- never actually did: when an admin adds keys to the pool, immediately
-- clear any backlog of confirmed-but-unassigned purchases, oldest first,
-- instead of leaving them stranded until someone opens the $10 Trials tab
-- and notices the "Assign key" button.
CREATE OR REPLACE FUNCTION public.tg_free_trial_keys_fulfill_backlog()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT id FROM public.trial_purchases
    WHERE status = 'confirmed' AND assigned_key_id IS NULL
    ORDER BY COALESCE(confirmed_at, created_at) ASC
  LOOP
    BEGIN
      PERFORM public.assign_trial_key_from_purchase(r.id);
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'No trial keys available%' THEN
        EXIT; -- pool exhausted again mid-backlog; nothing more to do this round
      END IF;
      BEGIN
        INSERT INTO public.admin_audit_logs (actor_id, actor_role, action, target_type, target_id, metadata)
        VALUES (NULL, 'system', 'trial_key_backlog_fulfill_failed', 'trial_purchase', r.id::text,
          jsonb_build_object('sqlstate', SQLSTATE, 'message', SQLERRM));
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
    END;
  END LOOP;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_free_trial_keys_fulfill_backlog ON public.free_trial_keys;
CREATE TRIGGER trg_free_trial_keys_fulfill_backlog
  AFTER INSERT ON public.free_trial_keys
  FOR EACH STATEMENT EXECUTE FUNCTION public.tg_free_trial_keys_fulfill_backlog();

-- One-time: the pool is already at 4 (below the 10-key threshold) and the
-- crossing-alert above has never had a chance to fire for it. Send it now
-- so this doesn't go unnoticed a moment longer than it already has.
DO $$
DECLARE
  v_remaining int;
  v_service_key text;
BEGIN
  SELECT count(*) INTO v_remaining FROM public.free_trial_keys WHERE claimed_by_user_id IS NULL;
  IF v_remaining <= 10 THEN
    BEGIN
      SELECT decrypted_secret INTO v_service_key
        FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key' LIMIT 1;
      IF v_service_key IS NOT NULL THEN
        PERFORM net.http_post(
          url := 'https://bbxahisheugfryyxfidg.supabase.co/functions/v1/send-admin-push',
          headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_service_key),
          body := jsonb_build_object(
            'event', 'trial_pool_low_stock',
            'title', '$10 trial key pool running low',
            'body', v_remaining || ' unclaimed trial key(s) left — top up in Free Trial before purchases start going unfulfilled.',
            'url', '/admin',
            'tag', 'trial-pool-low-stock'
          )
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
END $$;
