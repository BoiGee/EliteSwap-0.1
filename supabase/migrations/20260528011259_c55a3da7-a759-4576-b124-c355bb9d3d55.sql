CREATE OR REPLACE FUNCTION public.finance_overview(p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(gross_revenue_usd numeric, discounts_usd numeric, net_revenue_usd numeric, confirmed_payments_count integer, partner_commission_accrued_usd numeric, partner_commission_paid_usd numeric, partner_commission_balance_usd numeric, override_commission_accrued_usd numeric, override_commission_paid_usd numeric, override_commission_balance_usd numeric, operating_expenses_usd numeric, net_profit_usd numeric, cash_owed_usd numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_from TIMESTAMPTZ := COALESCE(p_from, '1970-01-01'::timestamptz);
  v_to TIMESTAMPTZ := COALESCE(p_to, now() + interval '1 day');
  v_from_d DATE := v_from::date;
  v_to_d DATE := v_to::date;
BEGIN
  IF NOT has_role('admin'::app_role) THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH rev AS (
    SELECT
      COALESCE(SUM(amount_usd), 0) AS gross,
      COALESCE(SUM(discount_amount_usd), 0) AS disc,
      COUNT(*)::INT AS cnt
    FROM public.payments
    WHERE status = 'confirmed'
      AND created_at >= v_from AND created_at < v_to
  ),
  comm AS (
    SELECT COALESCE(SUM(
      COALESCE(p.commission_base_usd_snapshot,
               public.payment_commission_base_usd(p.plan_id, p.amount_usd))
      * COALESCE(p.commission_pct_snapshot, pr.commission_pct) / 100.0
    ), 0) AS accrued
    FROM public.payments p
    JOIN public.partner_attributions a ON a.user_id = p.user_id
    JOIN public.partners pr ON pr.id = a.partner_id
    WHERE p.status = 'confirmed'
      AND p.created_at >= v_from AND p.created_at < v_to
  ),
  paid AS (
    SELECT COALESCE(SUM(po.amount_usd), 0) AS total
    FROM public.partner_payouts po
    WHERE po.paid_at >= v_from AND po.paid_at < v_to
  ),
  ovr_acc AS (
    SELECT COALESCE(SUM(e.amount_usd), 0) AS total
    FROM public.partner_override_earnings e
    JOIN public.payments p ON p.id = e.payment_id
    WHERE e.status = 'accrued'
      AND p.created_at >= v_from AND p.created_at < v_to
  ),
  ovr_paid AS (
    SELECT COALESCE(SUM(op.amount_usd), 0) AS total
    FROM public.partner_override_payouts op
    WHERE op.paid_at >= v_from AND op.paid_at < v_to
  ),
  exp AS (
    SELECT COALESCE(SUM(oe.amount_usd), 0) AS total
    FROM public.operating_expenses oe
    WHERE oe.occurred_on >= v_from_d AND oe.occurred_on <= v_to_d
  )
  SELECT
    rev.gross,
    rev.disc,
    rev.gross - rev.disc,
    rev.cnt,
    comm.accrued,
    paid.total,
    comm.accrued - paid.total,
    ovr_acc.total,
    ovr_paid.total,
    ovr_acc.total - ovr_paid.total,
    exp.total,
    (rev.gross - rev.disc) - comm.accrued - ovr_acc.total - exp.total,
    (comm.accrued - paid.total) + (ovr_acc.total - ovr_paid.total)
  FROM rev, comm, paid, ovr_acc, ovr_paid, exp;
END;
$function$;