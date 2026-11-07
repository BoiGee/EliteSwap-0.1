-- Plan sales (automatic, time-boxed, per plan) and annual billing, plus a security fix.
--
-- 1. SECURITY: pricing_plans_public (and two forum stats views) are plain auto-updatable views
--    owned by postgres, and anon/authenticated held INSERT/UPDATE/DELETE on them. A view
--    without security_invoker runs as its owner, so RLS on pricing_plans didn't apply: anyone
--    could PATCH /rest/v1/pricing_plans_public and rewrite plan prices (verified 2026-11-07 with
--    a no-match anonymous PATCH, which returned 200). Views are now read-only for clients.
-- 2. plan_promotions: per-plan percent_off with a start and end; the best active one applies.
-- 3. payments.billing_period ('monthly' | 'annual') and payments.promotion_id. Annual is billed
--    at pricing_plans.price_usd_annual and issues one key with 12x the plan's minutes.
-- 4. quote_plan_price(): the single pricing rule (list price for the period, then the better of
--    the active sale or a valid discount code, never both). payments_enforce_financials and
--    validate_discount_code both use it, so the pricing pages, crypto checkout, Mobile Money /
--    card checkout and the crypto verifier (which reads payments.amount_usd) can't disagree.
-- 5. Partners keep their full share: commission base = the plan's commission_base_usd, x12 for
--    annual, regardless of sale or code (as for codes before).

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.pricing_plans_public FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.forum_public_stats FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.my_forum_stats FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.reviews_public FROM anon, authenticated;

-- ---------------------------------------------------------------- promotions
CREATE TABLE IF NOT EXISTS public.plan_promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES public.pricing_plans(id) ON DELETE CASCADE,
  percent_off integer NOT NULL CHECK (percent_off BETWEEN 1 AND 90),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  label text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS plan_promotions_plan_window ON public.plan_promotions (plan_id, starts_at, ends_at);

ALTER TABLE public.plan_promotions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone reads plan promotions" ON public.plan_promotions;
CREATE POLICY "Anyone reads plan promotions" ON public.plan_promotions FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "Admins manage plan promotions" ON public.plan_promotions;
CREATE POLICY "Admins manage plan promotions" ON public.plan_promotions FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));
GRANT SELECT ON public.plan_promotions TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.plan_promotions TO authenticated;
GRANT ALL ON public.plan_promotions TO service_role;

-- ---------------------------------------------------------------- payments columns
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS billing_period text NOT NULL DEFAULT 'monthly';
ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_billing_period_check;
ALTER TABLE public.payments ADD CONSTRAINT payments_billing_period_check CHECK (billing_period IN ('monthly', 'annual'));
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS promotion_id uuid REFERENCES public.plan_promotions(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------- public plan view
CREATE OR REPLACE VIEW public.pricing_plans_public AS
SELECT p.id,
       p.name,
       p.description,
       p.price_usd,
       p.price_usd_annual,
       p.features,
       p.sort_order,
       p.key_duration_minutes,
       p.is_active,
       promo.percent_off AS promo_percent_off,
       promo.ends_at AS promo_ends_at,
       promo.label AS promo_label
  FROM public.pricing_plans p
  LEFT JOIN LATERAL (
    SELECT pr.percent_off, pr.ends_at, pr.label
      FROM public.plan_promotions pr
     WHERE pr.plan_id = p.id AND now() >= pr.starts_at AND now() < pr.ends_at
     ORDER BY pr.percent_off DESC
     LIMIT 1
  ) promo ON true
 WHERE p.is_active = true;
GRANT SELECT ON public.pricing_plans_public TO anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.pricing_plans_public FROM anon, authenticated;

-- ---------------------------------------------------------------- the pricing rule
CREATE OR REPLACE FUNCTION public.quote_plan_price(
  p_plan_id uuid,
  p_billing_period text DEFAULT 'monthly',
  p_discount_code text DEFAULT NULL,
  p_user_id uuid DEFAULT NULL
)
RETURNS TABLE(
  list_usd numeric,
  promotion_id uuid,
  promo_percent integer,
  code text,
  code_percent integer,
  applied_percent integer,
  discount_usd numeric,
  final_usd numeric,
  commission_base_usd numeric,
  code_reason text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan public.pricing_plans%ROWTYPE;
  v_annual boolean := p_billing_period = 'annual';
  v_list numeric;
  v_promo_id uuid;
  v_promo_pct integer := 0;
  v_code public.discount_codes%ROWTYPE;
  v_code_ok boolean := false;
  v_code_pct integer := 0;
  v_reason text;
  v_pct integer;
  v_discount numeric;
BEGIN
  SELECT * INTO v_plan FROM public.pricing_plans WHERE id = p_plan_id AND is_active;
  IF NOT FOUND THEN
    RETURN; -- no row: unknown or inactive plan
  END IF;
  v_list := CASE WHEN v_annual THEN v_plan.price_usd_annual ELSE v_plan.price_usd END;

  SELECT pr.id, pr.percent_off INTO v_promo_id, v_promo_pct
    FROM public.plan_promotions pr
   WHERE pr.plan_id = p_plan_id AND now() >= pr.starts_at AND now() < pr.ends_at
   ORDER BY pr.percent_off DESC
   LIMIT 1;
  v_promo_pct := COALESCE(v_promo_pct, 0);

  IF p_discount_code IS NOT NULL AND length(btrim(p_discount_code)) > 0 THEN
    SELECT dc.* INTO v_code FROM public.discount_codes dc WHERE upper(dc.code) = upper(btrim(p_discount_code)) LIMIT 1;
    IF NOT FOUND THEN
      v_reason := 'Invalid code';
    ELSIF NOT v_code.is_active THEN
      v_reason := 'Code is inactive';
    ELSIF v_code.expires_at IS NOT NULL AND v_code.expires_at <= now() THEN
      v_reason := 'Code has expired';
    ELSIF v_code.applies_to_plan_ids IS NOT NULL AND array_length(v_code.applies_to_plan_ids, 1) > 0
          AND NOT (p_plan_id = ANY(v_code.applies_to_plan_ids)) THEN
      v_reason := 'Code not valid for this plan';
    ELSIF v_code.redemption_mode = 'single_per_user' AND p_user_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM public.discount_redemptions r WHERE r.code_id = v_code.id AND r.user_id = p_user_id) THEN
      v_reason := 'You have already used this code';
    ELSIF v_code.redemption_mode = 'multi_use_capped' AND v_code.times_redeemed >= COALESCE(v_code.max_redemptions, 0) THEN
      v_reason := 'Code redemption limit reached';
    ELSE
      v_code_ok := true;
      v_code_pct := v_code.percent_off;
    END IF;
  END IF;

  -- The better of the sale and the code applies, never both. A code that doesn't beat the
  -- sale isn't used (and so isn't consumed).
  IF v_code_ok AND v_code_pct > v_promo_pct THEN
    v_pct := v_code_pct;
  ELSE
    IF v_code_ok THEN
      v_reason := 'The sale price is already better than this code';
      v_code_ok := false;
    END IF;
    v_pct := v_promo_pct;
  END IF;

  v_discount := CASE WHEN v_list IS NULL THEN NULL ELSE round(v_list * v_pct / 100.0, 2) END;

  RETURN QUERY SELECT
    v_list,
    CASE WHEN NOT v_code_ok AND v_promo_pct > 0 THEN v_promo_id END,
    v_promo_pct,
    CASE WHEN v_code_ok THEN upper(btrim(p_discount_code)) END,
    CASE WHEN v_code_ok THEN v_code_pct ELSE 0 END,
    v_pct,
    v_discount,
    v_list - v_discount,
    v_plan.commission_base_usd * CASE WHEN v_annual THEN 12 ELSE 1 END,
    v_reason;
END;
$$;
REVOKE ALL ON FUNCTION public.quote_plan_price(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.quote_plan_price(uuid, text, text, uuid) TO service_role;

-- ---------------------------------------------------------------- payment pricing trigger
CREATE OR REPLACE FUNCTION public.payments_enforce_financials()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  q record;
BEGIN
  NEW.billing_period := CASE WHEN NEW.billing_period = 'annual' THEN 'annual' ELSE 'monthly' END;

  -- Admins, payment managers and service_role record what was actually paid (backfills,
  -- manual payments); their inserts are trusted as-is.
  IF auth.uid() IS NULL OR public.has_role(auth.uid(), 'admin'::app_role) OR public.can_manage_payments(auth.uid()) THEN
    RETURN NEW;
  END IF;

  IF NEW.plan_id IS NULL THEN
    -- No plan -> force financials to NULL (verifier will reject anyway)
    NEW.amount_usd := NULL;
    NEW.discount_code := NULL;
    NEW.discount_amount_usd := NULL;
    NEW.promotion_id := NULL;
    NEW.commission_pct_snapshot := NULL;
    NEW.commission_base_usd_snapshot := NULL;
    RETURN NEW;
  END IF;

  SELECT * INTO q FROM public.quote_plan_price(NEW.plan_id, NEW.billing_period, NEW.discount_code, NEW.user_id);
  IF NOT FOUND THEN
    -- Unknown / inactive plan: null the financials
    NEW.amount_usd := NULL;
    NEW.discount_code := NULL;
    NEW.discount_amount_usd := NULL;
    NEW.promotion_id := NULL;
    NEW.commission_pct_snapshot := NULL;
    NEW.commission_base_usd_snapshot := NULL;
    RETURN NEW;
  END IF;

  IF q.list_usd IS NULL THEN
    RAISE EXCEPTION 'Annual billing isn''t available for this plan.' USING ERRCODE = '22023';
  END IF;
  -- The $0 plan ("Higher Requests") is priced by conversation; a payment against it can never
  -- be verified (18 were submitted, 16 rejected). Refuse it up front with a clear message.
  IF q.list_usd <= 0 THEN
    RAISE EXCEPTION 'This plan is priced on request. Message us from the chat button for a quote.' USING ERRCODE = '22023';
  END IF;

  NEW.amount_usd := q.final_usd;
  NEW.discount_code := q.code;
  NEW.discount_amount_usd := NULLIF(q.discount_usd, 0);
  NEW.promotion_id := q.promotion_id;
  NEW.commission_base_usd_snapshot := q.commission_base_usd;
  -- commission_pct_snapshot is driven by partner attribution elsewhere; null on user insert
  NEW.commission_pct_snapshot := NULL;
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------- coupon box
DROP FUNCTION IF EXISTS public.validate_discount_code(text, uuid);
CREATE FUNCTION public.validate_discount_code(p_code text, p_plan_id uuid, p_billing_period text DEFAULT 'monthly')
RETURNS TABLE(valid boolean, percent_off integer, discount_usd numeric, final_usd numeric, reason text, code_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  q record;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN QUERY SELECT false, 0, 0::numeric, 0::numeric, 'Not authenticated'::text, NULL::uuid;
    RETURN;
  END IF;
  SELECT * INTO q FROM public.quote_plan_price(p_plan_id, p_billing_period, p_code, auth.uid());
  IF NOT FOUND OR q.list_usd IS NULL OR q.list_usd <= 0 THEN
    RETURN QUERY SELECT false, 0, 0::numeric, 0::numeric,
      (CASE WHEN FOUND AND q.list_usd IS NULL THEN 'Annual billing isn''t available for this plan' ELSE 'Plan not found' END)::text, NULL::uuid;
    RETURN;
  END IF;
  IF q.code IS NULL THEN
    RETURN QUERY SELECT false, 0, 0::numeric, 0::numeric, COALESCE(q.code_reason, 'Invalid code')::text, NULL::uuid;
    RETURN;
  END IF;
  RETURN QUERY SELECT true, q.code_percent, q.discount_usd, q.final_usd, 'OK'::text,
    (SELECT dc.id FROM public.discount_codes dc WHERE upper(dc.code) = q.code LIMIT 1);
END;
$$;
REVOKE ALL ON FUNCTION public.validate_discount_code(text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.validate_discount_code(text, uuid, text) TO authenticated;

-- ---------------------------------------------------------------- Mobile Money / card checkout
DROP FUNCTION IF EXISTS public.create_gateway_payment(uuid, text);
CREATE FUNCTION public.create_gateway_payment(p_plan_id uuid, p_discount_code text DEFAULT NULL, p_billing_period text DEFAULT 'monthly')
RETURNS public.payments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.payments%ROWTYPE;
  v_recent integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in required' USING ERRCODE = '42501';
  END IF;
  IF NOT COALESCE((SELECT gateway_checkout_enabled FROM public.studio_pricing_config WHERE id = true), false) THEN
    RAISE EXCEPTION 'Mobile Money and card checkout is not available yet' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pricing_plans WHERE id = p_plan_id AND is_active AND price_usd > 0) THEN
    RAISE EXCEPTION 'Choose a plan to pay for' USING ERRCODE = '22023';
  END IF;

  -- Each checkout opens a pending row; stop a stuck button from opening dozens.
  SELECT count(*) INTO v_recent
    FROM public.payments
   WHERE user_id = v_uid AND payment_method = 'ogateway' AND status = 'pending'
     AND created_at > now() - interval '1 hour';
  IF v_recent >= 5 THEN
    RAISE EXCEPTION 'Too many open checkouts. Finish or wait for the last one, then try again.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.payments (user_id, currency, status, payment_method, plan_id, discount_code, billing_period)
  VALUES (v_uid, 'GHS', 'pending', 'ogateway', p_plan_id, NULLIF(btrim(p_discount_code), ''),
          CASE WHEN p_billing_period = 'annual' THEN 'annual' ELSE 'monthly' END)
  RETURNING * INTO v_row;

  IF v_row.amount_usd IS NULL OR v_row.amount_usd <= 0 THEN
    RAISE EXCEPTION 'This plan could not be priced' USING ERRCODE = '22023';
  END IF;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.create_gateway_payment(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_gateway_payment(uuid, text, text) TO authenticated;

-- ---------------------------------------------------------------- marketing copy
-- "Priority Processing" isn't implemented; support isn't staffed 24/7; the timer line is
-- dropped. Minutes are shown by the pricing UI from key_duration_minutes (x12 for annual).
UPDATE public.pricing_plans SET
  description = 'Stream and call as the character you choose, live.',
  features = ARRAY['Minutes never expire', 'Realtime character swap', 'Switch characters mid-stream', 'OBS-ready output', 'Live chat support']
WHERE name = 'Basic';
UPDATE public.pricing_plans SET
  description = 'Everything in Basic, plus Elite AI Background behind your character.',
  features = ARRAY['Everything in Basic', 'Elite AI Background', 'Minutes never expire', 'Live chat support']
WHERE name = 'Professional';
UPDATE public.pricing_plans SET
  description = 'For heavy, daily streaming with the full Elite toolkit.',
  features = ARRAY['Everything in Professional', 'Elite AI Background', 'Minutes never expire', 'Live chat support']
WHERE name = 'Enterprise';

-- ---------------------------------------------------------------- annual keys: 12x minutes
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

  v_new_token := public.generate_short_access_key();

  INSERT INTO public.api_keys (user_id, key, label, is_active, remaining_ms, payment_id, pool_key_id)
  VALUES (
    v_payment.user_id,
    v_new_token,
    v_plan_name || CASE WHEN v_payment.billing_period = 'annual' THEN ' (Annual)' ELSE '' END,
    true,
    (v_minutes::BIGINT) * 60000 * CASE WHEN v_payment.billing_period = 'annual' THEN 12 ELSE 1 END,
    v_payment.id,
    NULL
  )
  RETURNING id INTO v_new_key_id;

  UPDATE public.payments SET pending_key_assignment = false WHERE id = p_payment_id;

  RETURN v_new_key_id;
END;
$function$;

-- ---------------------------------------------------------------- partner page: annual price/name
CREATE OR REPLACE FUNCTION public.partner_commission_breakdown(p_partner_id uuid)
 RETURNS TABLE(payment_id uuid, user_id uuid, email_masked text, plan_name text, plan_price_usd numeric, amount_paid_usd numeric, commission_base_usd numeric, commission_pct numeric, commission_usd numeric, status text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_pct NUMERIC;
  v_is_admin BOOLEAN;
BEGIN
  v_is_admin := has_role('admin'::app_role);
  IF NOT (v_is_admin
          OR EXISTS (SELECT 1 FROM public.partners WHERE id = p_partner_id AND user_id = auth.uid())) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT p.commission_pct INTO v_pct FROM public.partners p WHERE p.id = p_partner_id;

  RETURN QUERY
  WITH resolved AS (
    SELECT
      pmt.id AS pid,
      pmt.user_id AS uid,
      pmt.amount_usd,
      pmt.status,
      pmt.created_at,
      COALESCE(pp.name || CASE WHEN pmt.billing_period = 'annual' THEN ' (Annual)' ELSE '' END, pp_amt.name, 'Custom payment') AS plan_name,
      COALESCE(CASE WHEN pmt.billing_period = 'annual' THEN pp.price_usd_annual ELSE pp.price_usd END, pp_amt.price_usd, pmt.amount_usd) AS plan_price,
      COALESCE(pmt.commission_base_usd_snapshot,
               public.payment_commission_base_usd(pmt.plan_id, pmt.amount_usd)) AS base_usd,
      COALESCE(pmt.commission_pct_snapshot, v_pct) AS eff_pct
    FROM public.payments pmt
    JOIN public.partner_attributions a ON a.user_id = pmt.user_id
    LEFT JOIN public.pricing_plans pp ON pp.id = pmt.plan_id
    LEFT JOIN LATERAL (
      SELECT pp2.name, pp2.price_usd
      FROM public.pricing_plans pp2
      WHERE pmt.plan_id IS NULL AND pp2.is_active = true AND pp2.price_usd = pmt.amount_usd
      ORDER BY pp2.sort_order LIMIT 1
    ) pp_amt ON true
    WHERE a.partner_id = p_partner_id
  )
  SELECT
    r.pid,
    r.uid,
    (CASE WHEN v_is_admin THEN COALESCE(pr.email,'')
         ELSE COALESCE(regexp_replace(pr.email, '^(.).+(@.+)$', '\1***\2'), 'unknown')
    END),
    r.plan_name,
    r.plan_price,
    r.amount_usd,
    r.base_usd,
    r.eff_pct,
    (CASE WHEN r.status = 'confirmed'
         THEN ROUND(r.base_usd * r.eff_pct / 100.0, 2)
         ELSE 0 END),
    r.status,
    r.created_at
  FROM resolved r
  LEFT JOIN public.profiles pr ON pr.user_id = r.uid
  ORDER BY r.created_at DESC;
END;
$function$;
