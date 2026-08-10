
-- 1. Discount codes table
CREATE TABLE public.discount_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  description TEXT,
  percent_off INTEGER NOT NULL CHECK (percent_off BETWEEN 1 AND 20),
  redemption_mode TEXT NOT NULL CHECK (redemption_mode IN ('single_per_user','multi_use_capped')),
  max_redemptions INTEGER,
  times_redeemed INTEGER NOT NULL DEFAULT 0,
  applies_to_plan_ids UUID[],
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT discount_codes_cap_required
    CHECK (redemption_mode <> 'multi_use_capped' OR (max_redemptions IS NOT NULL AND max_redemptions > 0))
);

-- Force code to uppercase on write
CREATE OR REPLACE FUNCTION public.discount_codes_normalize()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.code := upper(trim(NEW.code));
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER discount_codes_normalize_trg
BEFORE INSERT OR UPDATE ON public.discount_codes
FOR EACH ROW EXECUTE FUNCTION public.discount_codes_normalize();

ALTER TABLE public.discount_codes ENABLE ROW LEVEL SECURITY;

-- Admins: full CRUD
CREATE POLICY "Admins can view discount codes"
  ON public.discount_codes FOR SELECT TO authenticated
  USING (has_role('admin'::app_role));

CREATE POLICY "Admins can insert discount codes"
  ON public.discount_codes FOR INSERT TO authenticated
  WITH CHECK (has_role('admin'::app_role));

CREATE POLICY "Admins can update discount codes"
  ON public.discount_codes FOR UPDATE TO authenticated
  USING (has_role('admin'::app_role));

CREATE POLICY "Admins can delete discount codes"
  ON public.discount_codes FOR DELETE TO authenticated
  USING (has_role('admin'::app_role));

-- Authenticated: SELECT only active, non-expired codes (for client-side preview)
CREATE POLICY "Authenticated can view active discount codes"
  ON public.discount_codes FOR SELECT TO authenticated
  USING (is_active = true AND (expires_at IS NULL OR expires_at > now()));

-- 2. Discount redemptions table
CREATE TABLE public.discount_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_id UUID NOT NULL REFERENCES public.discount_codes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  payment_id UUID,
  discount_amount_usd NUMERIC NOT NULL,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_discount_redemptions_code ON public.discount_redemptions(code_id);
CREATE INDEX idx_discount_redemptions_user ON public.discount_redemptions(user_id);

ALTER TABLE public.discount_redemptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own redemptions"
  ON public.discount_redemptions FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Admins can view all redemptions"
  ON public.discount_redemptions FOR SELECT TO authenticated
  USING (has_role('admin'::app_role));

-- INSERT only via SECURITY DEFINER RPC (no policy = blocked)

-- 3. Payments table: add discount columns
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS discount_code TEXT,
  ADD COLUMN IF NOT EXISTS discount_amount_usd NUMERIC;

-- 4. RPC: validate_discount_code
CREATE OR REPLACE FUNCTION public.validate_discount_code(p_code TEXT, p_plan_id UUID)
RETURNS TABLE(valid BOOLEAN, percent_off INTEGER, discount_usd NUMERIC, final_usd NUMERIC, reason TEXT, code_id UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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

-- 5. RPC: record_discount_redemption (called by webhook with service role)
CREATE OR REPLACE FUNCTION public.record_discount_redemption(
  p_code TEXT,
  p_user_id UUID,
  p_payment_id UUID,
  p_discount_amount_usd NUMERIC
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_code_id UUID;
BEGIN
  SELECT id INTO v_code_id FROM public.discount_codes
  WHERE code = upper(trim(p_code)) FOR UPDATE;

  IF v_code_id IS NULL THEN
    RETURN false;
  END IF;

  -- Idempotency: skip if redemption for this payment already exists
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
