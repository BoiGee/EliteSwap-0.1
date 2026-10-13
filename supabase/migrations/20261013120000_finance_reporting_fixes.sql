-- Finance reporting fixes (checked against production data, 2026-10-13):
-- 1. payments.amount_usd is already net of discount (payments_enforce_financials stores
--    plan price minus discount), so gross = amount + discount and net = amount. The old
--    math subtracted discounts a second time. No confirmed payment has used a discount
--    yet, so no figure shown so far was affected; the first discount code would have been.
-- 2. Balances owed (commission, override, "cash owed") are as of the end of the range,
--    counted from the beginning. The old math netted payouts made inside the range against
--    commission accrued inside the range: "This month" showed $91.60 owed vs $1,283.75 real.
-- 3. Calendar dates use the admin's timezone (p_tz) instead of UTC, so an expense dated the
--    last day of a month no longer lands in two adjacent months, and chart months match the
--    admin's calendar. All-time no longer drops expenses dated before 1970.
-- 4. Downline counts every partner below this one, not only those with override earnings.
-- 5. EXECUTE limited to authenticated/service_role (each function also checks admin).

DROP FUNCTION IF EXISTS public.finance_overview(timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.finance_monthly_series(timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.finance_partner_rollup(timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION public.finance_safe_tz(p_tz text)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_tz) THEN p_tz ELSE 'UTC' END
$$;

CREATE FUNCTION public.finance_overview(
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_tz text DEFAULT 'UTC'
)
RETURNS TABLE(
  gross_revenue_usd numeric,
  discounts_usd numeric,
  net_revenue_usd numeric,
  confirmed_payments_count integer,
  partner_commission_accrued_usd numeric,
  partner_commission_paid_usd numeric,
  partner_commission_balance_usd numeric,
  override_commission_accrued_usd numeric,
  override_commission_paid_usd numeric,
  override_commission_balance_usd numeric,
  operating_expenses_usd numeric,
  net_profit_usd numeric,
  cash_owed_usd numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tz text := public.finance_safe_tz(p_tz);
  v_from timestamptz := COALESCE(p_from, '-infinity'::timestamptz);
  v_to timestamptz := COALESCE(p_to, now() + interval '1 day');
  -- An expense date counts if its local day starts inside [v_from, v_to).
  v_from_d date := CASE WHEN p_from IS NULL THEN '-infinity'::date ELSE (p_from AT TIME ZONE v_tz)::date END;
  v_to_d date := ((v_to - interval '1 microsecond') AT TIME ZONE v_tz)::date;
BEGIN
  IF NOT has_role('admin'::app_role) THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH rev AS (
    SELECT COALESCE(SUM(p.amount_usd + COALESCE(p.discount_amount_usd, 0)), 0) AS gross,
           COALESCE(SUM(p.discount_amount_usd), 0) AS disc,
           COALESCE(SUM(p.amount_usd), 0) AS net,
           COUNT(*)::int AS cnt
    FROM public.payments p
    WHERE p.status = 'confirmed' AND p.created_at >= v_from AND p.created_at < v_to
  ),
  comm AS (
    SELECT COALESCE(SUM(c.amount) FILTER (WHERE c.created_at >= v_from), 0) AS in_range,
           COALESCE(SUM(c.amount), 0) AS to_date
    FROM (
      SELECT p.created_at,
             COALESCE(p.commission_base_usd_snapshot, public.payment_commission_base_usd(p.plan_id, p.amount_usd))
               * COALESCE(p.commission_pct_snapshot, pr.commission_pct) / 100.0 AS amount
      FROM public.payments p
      JOIN public.partner_attributions a ON a.user_id = p.user_id
      JOIN public.partners pr ON pr.id = a.partner_id
      WHERE p.status = 'confirmed' AND p.created_at < v_to
    ) c
  ),
  paid AS (
    SELECT COALESCE(SUM(po.amount_usd) FILTER (WHERE po.paid_at >= v_from), 0) AS in_range,
           COALESCE(SUM(po.amount_usd), 0) AS to_date
    FROM public.partner_payouts po
    WHERE po.paid_at < v_to
  ),
  ovr AS (
    SELECT COALESCE(SUM(e.amount_usd) FILTER (WHERE p.created_at >= v_from), 0) AS in_range,
           COALESCE(SUM(e.amount_usd), 0) AS to_date
    FROM public.partner_override_earnings e
    JOIN public.payments p ON p.id = e.payment_id
    WHERE e.status = 'accrued' AND p.created_at < v_to
  ),
  ovr_paid AS (
    SELECT COALESCE(SUM(op.amount_usd) FILTER (WHERE op.paid_at >= v_from), 0) AS in_range,
           COALESCE(SUM(op.amount_usd), 0) AS to_date
    FROM public.partner_override_payouts op
    WHERE op.paid_at < v_to
  ),
  exp AS (
    SELECT COALESCE(SUM(oe.amount_usd), 0) AS total
    FROM public.operating_expenses oe
    WHERE oe.occurred_on >= v_from_d AND oe.occurred_on <= v_to_d
  )
  SELECT
    rev.gross,
    rev.disc,
    rev.net,
    rev.cnt,
    comm.in_range,
    paid.in_range,
    comm.to_date - paid.to_date,
    ovr.in_range,
    ovr_paid.in_range,
    ovr.to_date - ovr_paid.to_date,
    exp.total,
    rev.net - comm.in_range - ovr.in_range - exp.total,
    (comm.to_date - paid.to_date) + (ovr.to_date - ovr_paid.to_date)
  FROM rev, comm, paid, ovr, ovr_paid, exp;
END;
$function$;

CREATE FUNCTION public.finance_monthly_series(
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_tz text DEFAULT 'UTC'
)
RETURNS TABLE(
  month date,
  revenue_usd numeric,
  discounts_usd numeric,
  commissions_usd numeric,
  overrides_usd numeric,
  expenses_usd numeric,
  net_profit_usd numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tz text := public.finance_safe_tz(p_tz);
  v_from timestamptz := COALESCE(p_from, (SELECT MIN(created_at) FROM public.payments WHERE status = 'confirmed'), now());
  v_to timestamptz := COALESCE(p_to, now() + interval '1 day');
  v_from_m date := date_trunc('month', v_from AT TIME ZONE v_tz)::date;
  v_to_m date := date_trunc('month', (v_to - interval '1 microsecond') AT TIME ZONE v_tz)::date;
  -- All-time charts start at the first sale's month, so take that month's earlier expenses too.
  v_from_d date := CASE WHEN p_from IS NULL THEN v_from_m ELSE (v_from AT TIME ZONE v_tz)::date END;
  v_to_d date := ((v_to - interval '1 microsecond') AT TIME ZONE v_tz)::date;
BEGIN
  IF NOT has_role('admin'::app_role) THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH months AS (
    SELECT generate_series(v_from_m::timestamp, v_to_m::timestamp, interval '1 month')::date AS m
  ),
  rev AS (
    SELECT date_trunc('month', p.created_at AT TIME ZONE v_tz)::date AS m,
           SUM(p.amount_usd + COALESCE(p.discount_amount_usd, 0)) AS gross,
           SUM(p.discount_amount_usd) AS disc,
           SUM(p.amount_usd) AS net
    FROM public.payments p
    WHERE p.status = 'confirmed' AND p.created_at >= v_from AND p.created_at < v_to
    GROUP BY 1
  ),
  comm AS (
    SELECT date_trunc('month', p.created_at AT TIME ZONE v_tz)::date AS m,
           SUM(
             COALESCE(p.commission_base_usd_snapshot, public.payment_commission_base_usd(p.plan_id, p.amount_usd))
             * COALESCE(p.commission_pct_snapshot, pr.commission_pct) / 100.0
           ) AS total
    FROM public.payments p
    JOIN public.partner_attributions a ON a.user_id = p.user_id
    JOIN public.partners pr ON pr.id = a.partner_id
    WHERE p.status = 'confirmed' AND p.created_at >= v_from AND p.created_at < v_to
    GROUP BY 1
  ),
  ovr AS (
    SELECT date_trunc('month', p.created_at AT TIME ZONE v_tz)::date AS m,
           SUM(e.amount_usd) AS total
    FROM public.partner_override_earnings e
    JOIN public.payments p ON p.id = e.payment_id
    WHERE e.status = 'accrued' AND p.created_at >= v_from AND p.created_at < v_to
    GROUP BY 1
  ),
  exp AS (
    SELECT date_trunc('month', oe.occurred_on)::date AS m,
           SUM(oe.amount_usd) AS total
    FROM public.operating_expenses oe
    WHERE oe.occurred_on >= v_from_d AND oe.occurred_on <= v_to_d
    GROUP BY 1
  )
  SELECT
    months.m,
    COALESCE(rev.gross, 0),
    COALESCE(rev.disc, 0),
    COALESCE(comm.total, 0),
    COALESCE(ovr.total, 0),
    COALESCE(exp.total, 0),
    COALESCE(rev.net, 0) - COALESCE(comm.total, 0) - COALESCE(ovr.total, 0) - COALESCE(exp.total, 0)
  FROM months
  LEFT JOIN rev ON rev.m = months.m
  LEFT JOIN comm ON comm.m = months.m
  LEFT JOIN ovr ON ovr.m = months.m
  LEFT JOIN exp ON exp.m = months.m
  ORDER BY months.m;
END;
$function$;

CREATE FUNCTION public.finance_partner_rollup(
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_tz text DEFAULT 'UTC'
)
RETURNS TABLE(
  partner_id uuid,
  code text,
  display_name text,
  commission_pct numeric,
  is_active boolean,
  parent_partner_id uuid,
  referred_users integer,
  confirmed_payments integer,
  gross_earnings_usd numeric,
  paid_out_usd numeric,
  balance_owed_usd numeric,
  override_earned_usd numeric,
  override_paid_usd numeric,
  override_balance_usd numeric,
  downline_count integer
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_from timestamptz := COALESCE(p_from, '-infinity'::timestamptz);
  v_to timestamptz := COALESCE(p_to, now() + interval '1 day');
BEGIN
  IF NOT has_role('admin'::app_role) THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH RECURSIVE tree AS (
    -- UNION (not UNION ALL) also stops on a parent_partner_id cycle.
    SELECT pt.id AS ancestor_id, pt.id AS member_id FROM public.partners pt
    UNION
    SELECT t.ancestor_id, c.id FROM tree t JOIN public.partners c ON c.parent_partner_id = t.member_id
  ),
  downline AS (
    SELECT t.ancestor_id AS pid, COUNT(*)::int AS n FROM tree t WHERE t.member_id <> t.ancestor_id GROUP BY t.ancestor_id
  ),
  refs AS (
    SELECT a.partner_id AS pid, COUNT(*)::int AS n FROM public.partner_attributions a GROUP BY a.partner_id
  ),
  earned AS (
    SELECT c.pid,
           (COUNT(*) FILTER (WHERE c.created_at >= v_from))::int AS payments_in_range,
           COALESCE(SUM(c.amount) FILTER (WHERE c.created_at >= v_from), 0) AS in_range,
           COALESCE(SUM(c.amount), 0) AS to_date
    FROM (
      SELECT a.partner_id AS pid, p.created_at,
             COALESCE(p.commission_base_usd_snapshot, public.payment_commission_base_usd(p.plan_id, p.amount_usd))
               * COALESCE(p.commission_pct_snapshot, pr.commission_pct) / 100.0 AS amount
      FROM public.payments p
      JOIN public.partner_attributions a ON a.user_id = p.user_id
      JOIN public.partners pr ON pr.id = a.partner_id
      WHERE p.status = 'confirmed' AND p.created_at < v_to
    ) c
    GROUP BY c.pid
  ),
  paid AS (
    SELECT po.partner_id AS pid,
           COALESCE(SUM(po.amount_usd) FILTER (WHERE po.paid_at >= v_from), 0) AS in_range,
           COALESCE(SUM(po.amount_usd), 0) AS to_date
    FROM public.partner_payouts po
    WHERE po.paid_at < v_to
    GROUP BY po.partner_id
  ),
  ovr AS (
    SELECT e.beneficiary_partner_id AS pid,
           COALESCE(SUM(e.amount_usd) FILTER (WHERE p.created_at >= v_from), 0) AS in_range,
           COALESCE(SUM(e.amount_usd), 0) AS to_date
    FROM public.partner_override_earnings e
    JOIN public.payments p ON p.id = e.payment_id
    WHERE e.status = 'accrued' AND p.created_at < v_to
    GROUP BY e.beneficiary_partner_id
  ),
  ovr_paid AS (
    SELECT op.partner_id AS pid,
           COALESCE(SUM(op.amount_usd) FILTER (WHERE op.paid_at >= v_from), 0) AS in_range,
           COALESCE(SUM(op.amount_usd), 0) AS to_date
    FROM public.partner_override_payouts op
    WHERE op.paid_at < v_to
    GROUP BY op.partner_id
  )
  SELECT
    pr.id,
    pr.code,
    pr.display_name,
    pr.commission_pct,
    pr.is_active,
    pr.parent_partner_id,
    COALESCE(refs.n, 0),
    COALESCE(earned.payments_in_range, 0),
    ROUND(COALESCE(earned.in_range, 0), 2),
    COALESCE(paid.in_range, 0),
    ROUND(COALESCE(earned.to_date, 0), 2) - COALESCE(paid.to_date, 0),
    COALESCE(ovr.in_range, 0),
    COALESCE(ovr_paid.in_range, 0),
    COALESCE(ovr.to_date, 0) - COALESCE(ovr_paid.to_date, 0),
    COALESCE(downline.n, 0)
  FROM public.partners pr
  LEFT JOIN refs ON refs.pid = pr.id
  LEFT JOIN earned ON earned.pid = pr.id
  LEFT JOIN paid ON paid.pid = pr.id
  LEFT JOIN ovr ON ovr.pid = pr.id
  LEFT JOIN ovr_paid ON ovr_paid.pid = pr.id
  LEFT JOIN downline ON downline.pid = pr.id
  ORDER BY pr.code;
END;
$function$;

REVOKE ALL ON FUNCTION public.finance_safe_tz(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finance_overview(timestamptz, timestamptz, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.finance_monthly_series(timestamptz, timestamptz, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.finance_partner_rollup(timestamptz, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finance_overview(timestamptz, timestamptz, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finance_monthly_series(timestamptz, timestamptz, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finance_partner_rollup(timestamptz, timestamptz, text) TO authenticated, service_role;
