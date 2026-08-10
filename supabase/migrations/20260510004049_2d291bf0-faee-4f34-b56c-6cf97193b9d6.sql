
ALTER TABLE public.pricing_plans
  ADD COLUMN IF NOT EXISTS commission_base_usd numeric;

UPDATE public.pricing_plans SET commission_base_usd = 30  WHERE price_usd = 100  AND commission_base_usd IS NULL;
UPDATE public.pricing_plans SET commission_base_usd = 50  WHERE price_usd = 185  AND commission_base_usd IS NULL;
UPDATE public.pricing_plans SET commission_base_usd = 250 WHERE price_usd = 900  AND commission_base_usd IS NULL;

CREATE OR REPLACE FUNCTION public.partner_stats(p_partner_id uuid)
 RETURNS TABLE(referred_users integer, confirmed_payments integer, gross_earnings_usd numeric, paid_out_usd numeric, balance_owed_usd numeric, commission_pct numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_pct NUMERIC;
BEGIN
  IF NOT (has_role('admin'::app_role)
          OR EXISTS (SELECT 1 FROM public.partners WHERE id = p_partner_id AND user_id = auth.uid())) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT p.commission_pct INTO v_pct FROM public.partners p WHERE p.id = p_partner_id;
  RETURN QUERY
  WITH attr AS (
    SELECT user_id FROM public.partner_attributions WHERE partner_id = p_partner_id
  ),
  pay AS (
    SELECT pmt.id, pmt.plan_id, COALESCE(pp.commission_base_usd, pp.price_usd) AS base_usd
    FROM public.payments pmt
    JOIN attr a ON a.user_id = pmt.user_id
    LEFT JOIN public.pricing_plans pp ON pp.id = pmt.plan_id
    WHERE pmt.status = 'confirmed'
  ),
  payout AS (
    SELECT COALESCE(SUM(amount_usd),0) AS total FROM public.partner_payouts WHERE partner_id = p_partner_id
  )
  SELECT
    (SELECT COUNT(*)::INT FROM attr),
    (SELECT COUNT(*)::INT FROM pay),
    COALESCE(ROUND(SUM(pay.base_usd) * v_pct / 100.0, 2), 0),
    (SELECT total FROM payout),
    COALESCE(ROUND(SUM(pay.base_usd) * v_pct / 100.0, 2), 0) - (SELECT total FROM payout),
    v_pct
  FROM pay;
END;
$function$;

CREATE OR REPLACE FUNCTION public.partner_referrals(p_partner_id uuid)
 RETURNS TABLE(user_id uuid, email_masked text, display_name text, attributed_at timestamp with time zone, source text, confirmed_payments integer, total_commission_usd numeric, last_payment_status text, last_payment_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_pct NUMERIC; v_is_admin BOOLEAN;
BEGIN
  v_is_admin := has_role('admin'::app_role);
  IF NOT (v_is_admin
          OR EXISTS (SELECT 1 FROM public.partners WHERE id = p_partner_id AND user_id = auth.uid())) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT p.commission_pct INTO v_pct FROM public.partners p WHERE p.id = p_partner_id;

  RETURN QUERY
  SELECT
    a.user_id,
    CASE WHEN v_is_admin THEN COALESCE(pr.email,'')
         ELSE COALESCE(
           regexp_replace(pr.email, '^(.).+(@.+)$', '\1***\2'),
           'unknown')
    END,
    pr.display_name,
    a.attributed_at,
    a.source,
    COALESCE((SELECT COUNT(*)::INT FROM public.payments p2 WHERE p2.user_id = a.user_id AND p2.status='confirmed'),0),
    COALESCE((SELECT ROUND(SUM(COALESCE(pp.commission_base_usd, pp.price_usd)) * v_pct / 100.0, 2)
              FROM public.payments p2
              JOIN public.pricing_plans pp ON pp.id = p2.plan_id
              WHERE p2.user_id = a.user_id AND p2.status='confirmed'), 0),
    (SELECT p2.status FROM public.payments p2 WHERE p2.user_id = a.user_id ORDER BY p2.created_at DESC LIMIT 1),
    (SELECT p2.created_at FROM public.payments p2 WHERE p2.user_id = a.user_id ORDER BY p2.created_at DESC LIMIT 1)
  FROM public.partner_attributions a
  LEFT JOIN public.profiles pr ON pr.user_id = a.user_id
  WHERE a.partner_id = p_partner_id
  ORDER BY a.attributed_at DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.partner_commission_breakdown(p_partner_id uuid)
 RETURNS TABLE(payment_id uuid, user_id uuid, email_masked text, plan_name text, plan_price_usd numeric, amount_paid_usd numeric, commission_usd numeric, status text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  SELECT
    pmt.id,
    pmt.user_id,
    CASE WHEN v_is_admin THEN COALESCE(pr.email,'')
         ELSE COALESCE(regexp_replace(pr.email, '^(.).+(@.+)$', '\1***\2'), 'unknown')
    END,
    COALESCE(pp.name, '—'),
    pp.price_usd,
    pmt.amount_usd,
    CASE WHEN pmt.status = 'confirmed' AND pp.price_usd IS NOT NULL
         THEN ROUND(COALESCE(pp.commission_base_usd, pp.price_usd) * v_pct / 100.0, 2)
         ELSE 0 END,
    pmt.status,
    pmt.created_at
  FROM public.payments pmt
  JOIN public.partner_attributions a ON a.user_id = pmt.user_id
  LEFT JOIN public.pricing_plans pp ON pp.id = pmt.plan_id
  LEFT JOIN public.profiles pr ON pr.user_id = pmt.user_id
  WHERE a.partner_id = p_partner_id
  ORDER BY pmt.created_at DESC;
END;
$function$;
