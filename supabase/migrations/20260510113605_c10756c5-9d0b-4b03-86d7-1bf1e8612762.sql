CREATE OR REPLACE FUNCTION public.payment_commission_base_usd(p_plan_id uuid, p_amount_usd numeric)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(
    (SELECT COALESCE(pp.commission_base_usd, pp.price_usd)
       FROM public.pricing_plans pp
      WHERE pp.id = p_plan_id),
    (SELECT COALESCE(pp2.commission_base_usd, pp2.price_usd)
       FROM public.pricing_plans pp2
      WHERE p_plan_id IS NULL
        AND p_amount_usd IS NOT NULL
        AND pp2.is_active = true
        AND pp2.price_usd = p_amount_usd
      ORDER BY pp2.sort_order
      LIMIT 1),
    p_amount_usd,
    0
  );
$$;

CREATE OR REPLACE FUNCTION public.tg_payments_normalize_partner_credit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_plan_price numeric;
  v_matched_plan_id uuid;
  v_has_partner boolean;
  v_base numeric;
BEGIN
  IF NEW.plan_id IS NOT NULL AND NEW.amount_usd IS NULL THEN
    SELECT pp.price_usd INTO v_plan_price
    FROM public.pricing_plans pp
    WHERE pp.id = NEW.plan_id;

    IF v_plan_price IS NOT NULL THEN
      NEW.amount_usd := v_plan_price;
    END IF;
  END IF;

  IF NEW.plan_id IS NULL AND NEW.amount_usd IS NOT NULL THEN
    SELECT pp.id INTO v_matched_plan_id
    FROM public.pricing_plans pp
    WHERE pp.is_active = true
      AND pp.price_usd = NEW.amount_usd
    ORDER BY pp.sort_order
    LIMIT 1;

    IF v_matched_plan_id IS NOT NULL THEN
      NEW.plan_id := v_matched_plan_id;
    END IF;
  END IF;

  IF NEW.status = 'confirmed' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.partner_attributions pa
      WHERE pa.user_id = NEW.user_id
    ) INTO v_has_partner;

    IF v_has_partner AND NEW.plan_id IS NULL AND NEW.amount_usd IS NULL THEN
      RAISE EXCEPTION 'Partner payment must include a plan or amount before it can be confirmed.' USING ERRCODE = '23514';
    END IF;

    IF v_has_partner THEN
      v_base := public.payment_commission_base_usd(NEW.plan_id, NEW.amount_usd);
      IF COALESCE(v_base, 0) <= 0 THEN
        RAISE EXCEPTION 'Partner payment could not resolve a commission amount.' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payments_normalize_partner_credit ON public.payments;
CREATE TRIGGER payments_normalize_partner_credit
BEFORE INSERT OR UPDATE OF status, plan_id, amount_usd ON public.payments
FOR EACH ROW
EXECUTE FUNCTION public.tg_payments_normalize_partner_credit();

CREATE OR REPLACE FUNCTION public.admin_set_payment_status(p_payment_id uuid, p_status text)
RETURNS public.payments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_payment public.payments%ROWTYPE;
BEGIN
  IF NOT public.has_role('admin'::app_role) THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;

  IF p_status NOT IN ('confirmed', 'rejected') THEN
    RAISE EXCEPTION 'Invalid payment status' USING ERRCODE = '22023';
  END IF;

  UPDATE public.payments
  SET status = p_status,
      updated_at = now()
  WHERE id = p_payment_id
  RETURNING * INTO v_payment;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found' USING ERRCODE = 'P0002';
  END IF;

  RETURN v_payment;
END;
$$;

CREATE OR REPLACE FUNCTION public.partner_stats(p_partner_id uuid)
 RETURNS TABLE(referred_users integer, confirmed_payments integer, gross_earnings_usd numeric, paid_out_usd numeric, balance_owed_usd numeric, commission_pct numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $$
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
    SELECT pmt.id,
           public.payment_commission_base_usd(pmt.plan_id, pmt.amount_usd) AS base_usd
    FROM public.payments pmt
    JOIN attr a ON a.user_id = pmt.user_id
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
$$;

CREATE OR REPLACE FUNCTION public.partner_referrals(p_partner_id uuid)
 RETURNS TABLE(user_id uuid, email_masked text, display_name text, attributed_at timestamp with time zone, source text, confirmed_payments integer, total_commission_usd numeric, last_payment_status text, last_payment_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $$
#variable_conflict use_column
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
    a.user_id AS user_id,
    (CASE WHEN v_is_admin THEN COALESCE(pr.email,'')
         ELSE COALESCE(regexp_replace(pr.email, '^(.).+(@.+)$', '\1***\2'), 'unknown')
    END) AS email_masked,
    pr.display_name AS display_name,
    a.attributed_at AS attributed_at,
    a.source AS source,
    COALESCE((SELECT COUNT(*)::INT FROM public.payments p2 WHERE p2.user_id = a.user_id AND p2.status='confirmed'),0) AS confirmed_payments,
    COALESCE((
      SELECT ROUND(SUM(public.payment_commission_base_usd(p2.plan_id, p2.amount_usd)) * v_pct / 100.0, 2)
      FROM public.payments p2
      WHERE p2.user_id = a.user_id AND p2.status='confirmed'
    ), 0) AS total_commission_usd,
    (SELECT p2.status FROM public.payments p2 WHERE p2.user_id = a.user_id ORDER BY p2.created_at DESC LIMIT 1) AS last_payment_status,
    (SELECT p2.created_at FROM public.payments p2 WHERE p2.user_id = a.user_id ORDER BY p2.created_at DESC LIMIT 1) AS last_payment_at
  FROM public.partner_attributions a
  LEFT JOIN public.profiles pr ON pr.user_id = a.user_id
  WHERE a.partner_id = p_partner_id
  ORDER BY a.attributed_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.partner_commission_breakdown(p_partner_id uuid)
 RETURNS TABLE(payment_id uuid, user_id uuid, email_masked text, plan_name text, plan_price_usd numeric, amount_paid_usd numeric, commission_usd numeric, status text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $$
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
      COALESCE(pp.name, pp_amt.name, 'Custom payment') AS plan_name,
      COALESCE(pp.price_usd, pp_amt.price_usd, pmt.amount_usd) AS plan_price,
      public.payment_commission_base_usd(pmt.plan_id, pmt.amount_usd) AS base_usd
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
    r.pid AS payment_id,
    r.uid AS user_id,
    (CASE WHEN v_is_admin THEN COALESCE(pr.email,'')
         ELSE COALESCE(regexp_replace(pr.email, '^(.).+(@.+)$', '\1***\2'), 'unknown')
    END) AS email_masked,
    r.plan_name AS plan_name,
    r.plan_price AS plan_price_usd,
    r.amount_usd AS amount_paid_usd,
    (CASE WHEN r.status = 'confirmed'
         THEN ROUND(r.base_usd * v_pct / 100.0, 2)
         ELSE 0 END) AS commission_usd,
    r.status AS status,
    r.created_at AS created_at
  FROM resolved r
  LEFT JOIN public.profiles pr ON pr.user_id = r.uid
  ORDER BY r.created_at DESC;
END;
$$;