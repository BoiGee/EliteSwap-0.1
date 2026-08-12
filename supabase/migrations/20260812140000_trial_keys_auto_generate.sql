-- $10 trial pool ran completely dry (0/174 unclaimed, last topped up
-- 2026-08-11) with no ongoing low-stock monitoring — the only alert that
-- ever existed for this fired once, inline, during the migration that
-- introduced it, then nothing watched it again. Every trial confirmation
-- since has been failing with 'No trial keys available', including an
-- admin's manual attempt to confirm+assign a paying customer's purchase.
--
-- Root architectural mismatch: assign_trial_key_from_purchase() still draws
-- from a finite pre-stocked free_trial_keys table, a leftover from when
-- trials were an unpaid, deliberately-scarce giveaway. Trials are $10 now
-- (see 20260811053000, d249472) — the sibling paid-plan flow,
-- issue_api_key_for_payment(), already reflects that: it calls
-- generate_short_access_key() directly and inserts into api_keys
-- unconditionally, no pool, no scarcity, confirmed by reading its current
-- definition. A paying customer should never be blocked by "out of stock"
-- placeholder inventory.
--
-- Fix: assign_trial_key_from_purchase() now INSERTs a fresh free_trial_keys
-- row (already claimed) instead of SELECTing an existing unclaimed one.
-- This preserves the free_trial_keys/free_trial_assignments FK shape (both
-- still reference a real free_trial_keys.id, no schema change needed) while
-- making fulfillment unlimited, matching the paid flow. The old
-- crossing-10 low-stock push is removed as dead weight — there is no more
-- scarcity to warn about.
CREATE OR REPLACE FUNCTION public.assign_trial_key_from_purchase(p_purchase_id uuid)
RETURNS TABLE(api_key_id uuid, api_key text, expires_at timestamp with time zone, duration_ms bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_purchase   public.trial_purchases%ROWTYPE;
  v_pool_key_id uuid;
  v_new_api_key public.api_keys%ROWTYPE;
  v_short_key  text;
  v_duration   constant bigint := 240000;
  v_used_count int;
  v_next_session int;
  v_attempt int;
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

  -- Create a fresh, already-claimed slot rather than drawing from a finite
  -- pool. Retry on the (astronomically unlikely) unique-constraint clash
  -- against a legacy free_trial_keys.api_key value.
  v_attempt := 0;
  LOOP
    v_attempt := v_attempt + 1;
    v_short_key := public.generate_short_access_key();
    BEGIN
      INSERT INTO public.free_trial_keys (api_key, claimed_by_user_id, claimed_at, trial_duration_ms)
        VALUES (v_short_key, v_purchase.user_id, now(), v_duration)
        RETURNING id INTO v_pool_key_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF v_attempt >= 5 THEN
        RAISE;
      END IF;
    END;
  END LOOP;

  INSERT INTO public.api_keys (user_id, key, label, is_active, remaining_ms, expires_at, pool_key_id)
    VALUES (
      v_purchase.user_id,
      v_short_key,
      'Trial Key',
      true,
      v_duration,
      NULL,
      v_pool_key_id
    )
    RETURNING * INTO v_new_api_key;

  SELECT COALESCE(MAX(session_number), 0) + 1 INTO v_next_session
    FROM public.free_trial_assignments WHERE user_id = v_purchase.user_id;
  IF v_next_session > 2 THEN v_next_session := 2; END IF;

  INSERT INTO public.free_trial_assignments (user_id, free_trial_key_id, api_key_record_id, session_number)
    VALUES (v_purchase.user_id, v_pool_key_id, v_new_api_key.id, v_next_session)
    ON CONFLICT (user_id, session_number) DO NOTHING;

  UPDATE public.trial_purchases
    SET assigned_key_id = v_pool_key_id,
        updated_at = now()
    WHERE id = p_purchase_id;

  api_key_id := v_new_api_key.id;
  api_key := v_new_api_key.key;
  expires_at := v_new_api_key.expires_at;
  duration_ms := v_duration;
  RETURN NEXT;
END;
$function$;
