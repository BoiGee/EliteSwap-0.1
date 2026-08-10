
-- 1) BEFORE INSERT trigger: for non-privileged inserters, recompute amount/discount/commission
--    from the referenced pricing_plans + discount_codes, ignoring anything the client sent.
CREATE OR REPLACE FUNCTION public.payments_sanitize_client_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_is_priv boolean := false;
  v_plan_price numeric;
  v_pct integer;
  v_applies uuid[];
  v_expires timestamptz;
  v_active boolean;
BEGIN
  -- Service role / admin / payment manager inserts are trusted as-is.
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;
  v_is_priv := public.has_role(v_uid, 'admin'::app_role) OR public.can_manage_payments(v_uid);
  IF v_is_priv THEN
    RETURN NEW;
  END IF;

  -- Force commission snapshots to be admin/trigger-set only.
  NEW.commission_pct_snapshot := NULL;
  NEW.commission_base_usd_snapshot := NULL;

  -- Recompute amount_usd from plan_id.
  IF NEW.plan_id IS NOT NULL THEN
    SELECT price_usd INTO v_plan_price
    FROM public.pricing_plans
    WHERE id = NEW.plan_id AND is_active = true;
    NEW.amount_usd := v_plan_price;
  ELSE
    NEW.amount_usd := NULL;
  END IF;

  -- Recompute discount_amount_usd from discount_code (if valid + applicable).
  NEW.discount_amount_usd := NULL;
  IF NEW.discount_code IS NOT NULL AND NEW.amount_usd IS NOT NULL THEN
    SELECT percent_off, applies_to_plan_ids, expires_at, is_active
      INTO v_pct, v_applies, v_expires, v_active
    FROM public.discount_codes
    WHERE lower(code) = lower(NEW.discount_code)
    LIMIT 1;
    IF v_active IS TRUE
       AND (v_expires IS NULL OR v_expires > now())
       AND (v_applies IS NULL OR array_length(v_applies,1) IS NULL OR NEW.plan_id = ANY(v_applies))
       AND v_pct IS NOT NULL THEN
      NEW.discount_amount_usd := round((NEW.amount_usd * v_pct / 100.0)::numeric, 2);
    ELSE
      -- Invalid code -> drop it so it isn't shown as applied.
      NEW.discount_code := NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payments_sanitize_client_insert_trg ON public.payments;
CREATE TRIGGER payments_sanitize_client_insert_trg
BEFORE INSERT ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.payments_sanitize_client_insert();

-- 2) Tighten the user-facing INSERT policy: user rows must not carry commission snapshots.
DROP POLICY IF EXISTS "Users can insert own payments" ON public.payments;
CREATE POLICY "Users can insert own payments"
ON public.payments
FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = user_id
  AND status = ANY (ARRAY['pending'::text, 'pending_review'::text])
  AND payment_method = 'crypto'::text
  AND commission_pct_snapshot IS NULL
  AND commission_base_usd_snapshot IS NULL
);
