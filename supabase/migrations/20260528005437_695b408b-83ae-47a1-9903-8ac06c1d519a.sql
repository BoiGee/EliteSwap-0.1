
CREATE OR REPLACE FUNCTION public.tg_payments_normalize_amounts()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = 'public' AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_is_admin BOOLEAN := false;
  v_plan_price NUMERIC;
  v_code RECORD;
  v_already_used INTEGER;
  v_valid BOOLEAN := false;
  v_discount NUMERIC := 0;
BEGIN
  -- Service role and admin inserts are trusted (admin UI uses RPCs).
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF v_uid IS NOT NULL THEN
    v_is_admin := public.has_role('admin'::app_role);
  END IF;
  IF v_is_admin THEN
    RETURN NEW;
  END IF;

  -- For regular users, derive the trusted price from the plan and validate
  -- the discount server-side. Anything the client put in is overwritten.
  IF NEW.plan_id IS NULL THEN
    NEW.amount_usd := NULL;
    NEW.discount_code := NULL;
    NEW.discount_amount_usd := NULL;
    RETURN NEW;
  END IF;

  SELECT price_usd INTO v_plan_price FROM public.pricing_plans
  WHERE id = NEW.plan_id AND is_active = true;

  IF v_plan_price IS NULL THEN
    NEW.amount_usd := NULL;
    NEW.discount_code := NULL;
    NEW.discount_amount_usd := NULL;
    RETURN NEW;
  END IF;

  IF NEW.discount_code IS NOT NULL AND length(trim(NEW.discount_code)) > 0 THEN
    SELECT * INTO v_code FROM public.discount_codes
    WHERE code = upper(trim(NEW.discount_code));

    IF FOUND
       AND v_code.is_active
       AND (v_code.expires_at IS NULL OR v_code.expires_at > now())
       AND (v_code.applies_to_plan_ids IS NULL
            OR array_length(v_code.applies_to_plan_ids, 1) IS NULL
            OR NEW.plan_id = ANY(v_code.applies_to_plan_ids))
    THEN
      IF v_code.redemption_mode = 'single_per_user' THEN
        SELECT COUNT(*) INTO v_already_used FROM public.discount_redemptions
        WHERE code_id = v_code.id AND user_id = v_uid;
        v_valid := v_already_used = 0;
      ELSIF v_code.redemption_mode = 'multi_use_capped' THEN
        v_valid := v_code.times_redeemed < COALESCE(v_code.max_redemptions, 0);
      ELSE
        v_valid := true;
      END IF;
    END IF;
  END IF;

  IF v_valid THEN
    v_discount := ROUND(v_plan_price * v_code.percent_off / 100.0, 2);
    NEW.discount_code := upper(trim(NEW.discount_code));
    NEW.discount_amount_usd := v_discount;
    NEW.amount_usd := ROUND(v_plan_price - v_discount, 2);
  ELSE
    NEW.discount_code := NULL;
    NEW.discount_amount_usd := NULL;
    NEW.amount_usd := v_plan_price;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_payments_normalize_amounts ON public.payments;
CREATE TRIGGER tg_payments_normalize_amounts
BEFORE INSERT ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.tg_payments_normalize_amounts();
