
-- 1. Public pricing view (excludes commission_base_usd, low_stock_threshold)
CREATE OR REPLACE VIEW public.pricing_plans_public
WITH (security_invoker = on) AS
SELECT id, name, description, price_usd, price_usd_annual,
       features, sort_order, key_duration_minutes, is_active
FROM public.pricing_plans
WHERE is_active = true;

GRANT SELECT ON public.pricing_plans_public TO anon, authenticated;

-- 2. Tighten payments insert: server-side resolution of financial fields
CREATE OR REPLACE FUNCTION public.payments_enforce_financials()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan_price numeric;
  v_plan_commission numeric;
  v_discount_pct integer;
  v_discount_amount numeric;
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

  IF v_plan_price IS NULL THEN
    -- Unknown / inactive plan: null the financials
    NEW.amount_usd := NULL;
    NEW.discount_amount_usd := NULL;
    NEW.commission_pct_snapshot := NULL;
    NEW.commission_base_usd_snapshot := NULL;
    RETURN NEW;
  END IF;

  -- Resolve discount strictly from server-side discount_codes
  v_discount_amount := 0;
  IF NEW.discount_code IS NOT NULL AND length(btrim(NEW.discount_code)) > 0 THEN
    SELECT percent_off INTO v_discount_pct
    FROM public.discount_codes
    WHERE upper(code) = upper(btrim(NEW.discount_code))
      AND is_active = true
      AND (expires_at IS NULL OR expires_at > now())
      AND (max_redemptions IS NULL OR times_redeemed < max_redemptions)
      AND (
        applies_to_plan_ids IS NULL
        OR array_length(applies_to_plan_ids, 1) IS NULL
        OR NEW.plan_id = ANY(applies_to_plan_ids)
      )
    LIMIT 1;

    IF v_discount_pct IS NOT NULL THEN
      v_discount_amount := round((v_plan_price * v_discount_pct / 100.0)::numeric, 2);
    ELSE
      -- Invalid code: clear it
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
$$;

DROP TRIGGER IF EXISTS trg_payments_enforce_financials ON public.payments;
CREATE TRIGGER trg_payments_enforce_financials
BEFORE INSERT ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.payments_enforce_financials();
