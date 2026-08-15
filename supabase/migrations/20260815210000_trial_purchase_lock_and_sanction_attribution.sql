-- Full-repo audit (2026-08-15) follow-up on two smaller access/integrity gaps.
--
-- 1) assign_trial_key_from_purchase() locks only the single purchase row
--    being assigned, then separately counts the user's already-assigned
--    trial purchases. Two different pending purchases for the same user
--    confirmed near-simultaneously (e.g. a webhook and reconcile-trial-
--    purchases racing on two separate rows) could both read the count
--    before either commits its assigned_key_id, exceeding the 2-trial cap —
--    the same bug family as the 813-duplicate-key recursion incident
--    (20260812180000). Adds a per-user advisory lock, held for the
--    transaction, before the count check.
--
-- 2) "Staff insert sanctions" on forum_user_sanctions only checks
--    is_staff(auth.uid()); it doesn't constrain issued_by, so a raw client
--    insert (bypassing the mod_apply_sanction() RPC, which already sets
--    issued_by := auth.uid() correctly) could misattribute a moderation
--    action to a different staff member. Defense-in-depth: constrain the
--    RLS policy the same way the RPC already behaves. No behavior change
--    for the RPC path (SECURITY DEFINER functions aren't subject to the
--    caller's RLS policies).

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

  -- Serialize concurrent assignment attempts for the same user so the
  -- 2-trial cap below can't be raced by two purchases confirming at once.
  -- Distinct salt (82400173) from the unrelated decart-key lock namespace
  -- (71833091, see 20260715231702) so the two never collide.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_purchase.user_id::text, 82400173));

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

DROP POLICY IF EXISTS "Staff insert sanctions" ON public.forum_user_sanctions;
CREATE POLICY "Staff insert sanctions"
ON public.forum_user_sanctions
FOR INSERT TO authenticated
WITH CHECK (public.is_staff(auth.uid()) AND issued_by = auth.uid());
