-- issue_api_key_for_payment: stop consuming a real Decart credential per
-- paid signup. Since mint_studio_credentials now always resolves the real
-- decart_key via assign_shared_decart_key() regardless of what a user's
-- own .key value is (see shared-decart-pool.sql), api_key_pool's stock of
-- real keys was only ever being burned as an arbitrary opaque token here —
-- any random string works identically. Generates one directly instead.
--
-- No FK constraint exists on api_keys.pool_key_id (verified against the
-- live schema), and pool_key_id IS NOT NULL already doesn't cleanly
-- separate trial vs paid in the real data (both cohorts are mixed) — so
-- leaving it NULL for new rows changes nothing load-bearing. 177 existing
-- rows already have NULL pool_key_id, so this is an already-normal state,
-- not a new one.
--
-- New tokens get an esw_ prefix (vs. the old dct_ real-Decart-key-shaped
-- values) specifically so nobody mistakes one for a real Decart secret
-- going forward.
CREATE OR REPLACE FUNCTION public.issue_api_key_for_payment(p_payment_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_payment    public.payments%ROWTYPE;
  v_minutes    INTEGER;
  v_plan_name  TEXT;
  v_new_key_id UUID;
  v_new_token  TEXT;
  v_caller     UUID := auth.uid();
  v_role       TEXT := auth.role();
  v_can_manage BOOLEAN := false;
BEGIN
  SELECT * INTO v_payment FROM public.payments WHERE id = p_payment_id;
  IF NOT FOUND OR v_payment.status <> 'confirmed' THEN
    RETURN NULL;
  END IF;

  IF v_caller IS NOT NULL THEN
    v_can_manage := public.can_manage_payments(v_caller);
  END IF;

  IF v_role <> 'service_role'
     AND (v_caller IS NULL
          OR (v_caller <> v_payment.user_id AND NOT v_can_manage)) THEN
    RAISE EXCEPTION 'not authorized to issue key for this payment';
  END IF;

  IF EXISTS (SELECT 1 FROM public.api_keys WHERE payment_id = p_payment_id) THEN
    UPDATE public.payments SET pending_key_assignment = false WHERE id = p_payment_id;
    RETURN NULL;
  END IF;

  IF v_payment.plan_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT key_duration_minutes, name
    INTO v_minutes, v_plan_name
    FROM public.pricing_plans
    WHERE id = v_payment.plan_id;

  IF v_minutes IS NULL OR v_minutes <= 0 THEN
    RETURN NULL;
  END IF;

  v_new_token := 'esw_' || encode(extensions.gen_random_bytes(24), 'hex');

  BEGIN
    INSERT INTO public.api_keys (user_id, key, label, is_active, remaining_ms, payment_id, pool_key_id)
    VALUES (
      v_payment.user_id,
      v_new_token,
      v_plan_name,
      true,
      (v_minutes::BIGINT) * 60000,
      v_payment.id,
      NULL
    )
    RETURNING id INTO v_new_key_id;
  EXCEPTION WHEN unique_violation THEN
    -- Vanishingly unlikely (24 random bytes), but retry once with a fresh
    -- token rather than silently failing the payment's key issuance.
    v_new_token := 'esw_' || encode(extensions.gen_random_bytes(24), 'hex');
    INSERT INTO public.api_keys (user_id, key, label, is_active, remaining_ms, payment_id, pool_key_id)
    VALUES (
      v_payment.user_id,
      v_new_token,
      v_plan_name,
      true,
      (v_minutes::BIGINT) * 60000,
      v_payment.id,
      NULL
    )
    RETURNING id INTO v_new_key_id;
  END;

  UPDATE public.payments SET pending_key_assignment = false WHERE id = p_payment_id;

  RETURN v_new_key_id;
END;
$function$;
