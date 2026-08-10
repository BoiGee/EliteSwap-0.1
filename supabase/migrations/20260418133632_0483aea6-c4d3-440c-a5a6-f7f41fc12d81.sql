
-- Recreate functions with explicit SET search_path (linter wants it pinned)
CREATE OR REPLACE FUNCTION public.discount_codes_normalize()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = 'public' AS $$
BEGIN
  NEW.code := upper(trim(NEW.code));
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_discount_code(p_code TEXT, p_plan_id UUID)
RETURNS TABLE(valid BOOLEAN, percent_off INTEGER, discount_usd NUMERIC, final_usd NUMERIC, reason TEXT, code_id UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = 'public' AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_code_record RECORD;
  v_plan_price NUMERIC;
  v_already_used INTEGER;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN QUERY SELECT false, 0, 0::NUMERIC, 0::NUMERIC, 'Not authenticated'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  SELECT * INTO v_code_record FROM public.discount_codes
  WHERE code = upper(trim(p_code));

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0, 0::NUMERIC, 0::NUMERIC, 'Invalid code'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF NOT v_code_record.is_active THEN
    RETURN QUERY SELECT false, 0, 0::NUMERIC, 0::NUMERIC, 'Code is inactive'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF v_code_record.expires_at IS NOT NULL AND v_code_record.expires_at <= now() THEN
    RETURN QUERY SELECT false, 0, 0::NUMERIC, 0::NUMERIC, 'Code has expired'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF v_code_record.applies_to_plan_ids IS NOT NULL
     AND array_length(v_code_record.applies_to_plan_ids, 1) > 0
     AND NOT (p_plan_id = ANY(v_code_record.applies_to_plan_ids)) THEN
    RETURN QUERY SELECT false, 0, 0::NUMERIC, 0::NUMERIC, 'Code not valid for this plan'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF v_code_record.redemption_mode = 'single_per_user' THEN
    SELECT COUNT(*) INTO v_already_used FROM public.discount_redemptions
    WHERE code_id = v_code_record.id AND user_id = v_user_id;
    IF v_already_used > 0 THEN
      RETURN QUERY SELECT false, 0, 0::NUMERIC, 0::NUMERIC, 'You have already used this code'::TEXT, NULL::UUID;
      RETURN;
    END IF;
  ELSIF v_code_record.redemption_mode = 'multi_use_capped' THEN
    IF v_code_record.times_redeemed >= COALESCE(v_code_record.max_redemptions, 0) THEN
      RETURN QUERY SELECT false, 0, 0::NUMERIC, 0::NUMERIC, 'Code redemption limit reached'::TEXT, NULL::UUID;
      RETURN;
    END IF;
  END IF;

  SELECT price_usd INTO v_plan_price FROM public.pricing_plans
  WHERE id = p_plan_id AND is_active = true;

  IF v_plan_price IS NULL THEN
    RETURN QUERY SELECT false, 0, 0::NUMERIC, 0::NUMERIC, 'Plan not found'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  RETURN QUERY SELECT
    true,
    v_code_record.percent_off,
    ROUND(v_plan_price * v_code_record.percent_off / 100.0, 2),
    ROUND(v_plan_price - (v_plan_price * v_code_record.percent_off / 100.0), 2),
    'OK'::TEXT,
    v_code_record.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_discount_redemption(
  p_code TEXT,
  p_user_id UUID,
  p_payment_id UUID,
  p_discount_amount_usd NUMERIC
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = 'public' AS $$
DECLARE
  v_code_id UUID;
BEGIN
  SELECT id INTO v_code_id FROM public.discount_codes
  WHERE code = upper(trim(p_code)) FOR UPDATE;

  IF v_code_id IS NULL THEN
    RETURN false;
  END IF;

  IF EXISTS (SELECT 1 FROM public.discount_redemptions WHERE payment_id = p_payment_id) THEN
    RETURN true;
  END IF;

  INSERT INTO public.discount_redemptions (code_id, user_id, payment_id, discount_amount_usd)
  VALUES (v_code_id, p_user_id, p_payment_id, p_discount_amount_usd);

  UPDATE public.discount_codes
  SET times_redeemed = times_redeemed + 1, updated_at = now()
  WHERE id = v_code_id;

  RETURN true;
END;
$$;
