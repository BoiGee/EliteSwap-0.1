-- Customer payments can no longer be filed against the $0 custom-quote plan.

CREATE OR REPLACE FUNCTION public.payments_enforce_financials()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_plan_price numeric;
  v_plan_commission numeric;
  v_discount_pct integer;
  v_discount_amount numeric;
  v_code RECORD;
  v_already_used integer;
  v_code_valid boolean;
BEGIN
  -- Admins/service_role inserts (e.g. backfills) bypass enforcement
  IF auth.uid() IS NULL OR public.has_role(auth.uid(), 'admin'::app_role) THEN
    RETURN NEW;
  END IF;

  IF NEW.plan_id IS NULL THEN
    -- No plan -> force financials to NULL (verifier will reject anyway)
    NEW.amount_usd := NULL;
    NEW.discount_amount_usd := NULL;
    NEW.commission_pct_snapshot := NULL;
    NEW.commission_base_usd_snapshot := NULL;
    RETURN NEW;
  END IF;

  SELECT price_usd, commission_base_usd
    INTO v_plan_price, v_plan_commission
  FROM public.pricing_plans
  WHERE id = NEW.plan_id AND is_active = true;

  -- The $0 plan ("Higher Requests") is priced by conversation; a payment against it can never
  -- be verified (18 were submitted, 16 rejected). Refuse it up front with a clear message.
  IF v_plan_price IS NOT NULL AND v_plan_price <= 0 THEN
    RAISE EXCEPTION 'This plan is priced on request. Message us from the chat button for a quote.' USING ERRCODE = '22023';
  END IF;

  IF v_plan_price IS NULL THEN
    -- Unknown / inactive plan: null the financials
    NEW.amount_usd := NULL;
    NEW.discount_amount_usd := NULL;
    NEW.commission_pct_snapshot := NULL;
    NEW.commission_base_usd_snapshot := NULL;
    RETURN NEW;
  END IF;

  -- Resolve discount strictly from server-side discount_codes, including
  -- redemption_mode — a single_per_user code has no max_redemptions to
  -- check against, so that half of the validation has to be explicit.
  v_discount_amount := 0;
  IF NEW.discount_code IS NOT NULL AND length(btrim(NEW.discount_code)) > 0 THEN
    SELECT * INTO v_code
    FROM public.discount_codes
    WHERE upper(code) = upper(btrim(NEW.discount_code))
      AND is_active = true
      AND (expires_at IS NULL OR expires_at > now())
      AND (
        applies_to_plan_ids IS NULL
        OR array_length(applies_to_plan_ids, 1) IS NULL
        OR NEW.plan_id = ANY(applies_to_plan_ids)
      )
    LIMIT 1;

    v_code_valid := FOUND;
    IF v_code_valid AND v_code.redemption_mode = 'single_per_user' THEN
      SELECT COUNT(*) INTO v_already_used
      FROM public.discount_redemptions
      WHERE code_id = v_code.id AND user_id = NEW.user_id;
      v_code_valid := v_already_used = 0;
    ELSIF v_code_valid AND v_code.redemption_mode = 'multi_use_capped' THEN
      v_code_valid := v_code.times_redeemed < COALESCE(v_code.max_redemptions, 0);
    END IF;

    IF v_code_valid THEN
      v_discount_pct := v_code.percent_off;
      v_discount_amount := round((v_plan_price * v_discount_pct / 100.0)::numeric, 2);
    ELSE
      -- Invalid / already-used / exhausted code: clear it
      NEW.discount_code := NULL;
    END IF;
  ELSE
    NEW.discount_code := NULL;
  END IF;

  NEW.amount_usd := v_plan_price - v_discount_amount;
  NEW.discount_amount_usd := CASE WHEN v_discount_amount > 0 THEN v_discount_amount ELSE NULL END;
  NEW.commission_base_usd_snapshot := v_plan_commission;
  -- commission_pct_snapshot is driven by partner attribution elsewhere; null on user insert
  NEW.commission_pct_snapshot := NULL;

  RETURN NEW;
END;
$function$;
