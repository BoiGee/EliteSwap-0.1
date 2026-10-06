-- New shareable profit per plan (partner % and the 5% override apply to this base).
-- Affects payments created from now on only: payments_enforce_financials copies the base onto
-- each payment at insert (commission_base_usd_snapshot), so confirmed and pending payments keep
-- the base that was in force when they were made ($43 / $50 / $200).
UPDATE public.pricing_plans SET commission_base_usd = 55, updated_at = now() WHERE name = 'Basic' AND price_usd = 130;
UPDATE public.pricing_plans SET commission_base_usd = 63, updated_at = now() WHERE name = 'Professional' AND price_usd = 210;
UPDATE public.pricing_plans SET commission_base_usd = 250, updated_at = now() WHERE name = 'Enterprise' AND price_usd = 1000;

DO $$
BEGIN
  IF (SELECT count(*) FROM public.pricing_plans
       WHERE (name, price_usd, commission_base_usd) IN (('Basic', 130, 55), ('Professional', 210, 63), ('Enterprise', 1000, 250))) <> 3 THEN
    RAISE EXCEPTION 'Expected to update exactly the Basic/Professional/Enterprise plans; check plan names and prices';
  END IF;
END $$;
