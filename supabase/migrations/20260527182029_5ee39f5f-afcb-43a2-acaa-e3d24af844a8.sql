
-- =========================
-- Expense categories
-- =========================
CREATE TABLE public.expense_categories (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  is_archived BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.expense_categories TO authenticated;
GRANT ALL ON public.expense_categories TO service_role;

ALTER TABLE public.expense_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage expense categories"
  ON public.expense_categories
  FOR ALL
  TO authenticated
  USING (has_role('admin'::app_role))
  WITH CHECK (has_role('admin'::app_role));

CREATE TRIGGER trg_expense_categories_updated
  BEFORE UPDATE ON public.expense_categories
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.expense_categories (name) VALUES
  ('Ads'), ('Infrastructure'), ('Salaries'), ('Refunds'), ('Misc')
ON CONFLICT (name) DO NOTHING;

-- =========================
-- Operating expenses (offsite)
-- =========================
CREATE TABLE public.operating_expenses (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  occurred_on DATE NOT NULL DEFAULT CURRENT_DATE,
  category_id UUID NOT NULL REFERENCES public.expense_categories(id) ON DELETE RESTRICT,
  amount_usd NUMERIC NOT NULL CHECK (amount_usd >= 0),
  vendor TEXT,
  note TEXT,
  created_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.operating_expenses TO authenticated;
GRANT ALL ON public.operating_expenses TO service_role;

ALTER TABLE public.operating_expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage operating expenses"
  ON public.operating_expenses
  FOR ALL
  TO authenticated
  USING (has_role('admin'::app_role))
  WITH CHECK (has_role('admin'::app_role));

CREATE INDEX idx_operating_expenses_occurred_on ON public.operating_expenses(occurred_on);
CREATE INDEX idx_operating_expenses_category ON public.operating_expenses(category_id);

CREATE TRIGGER trg_operating_expenses_updated
  BEFORE UPDATE ON public.operating_expenses
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =========================
-- finance_overview RPC
-- =========================
CREATE OR REPLACE FUNCTION public.finance_overview(p_from TIMESTAMPTZ DEFAULT NULL, p_to TIMESTAMPTZ DEFAULT NULL)
RETURNS TABLE(
  gross_revenue_usd NUMERIC,
  discounts_usd NUMERIC,
  net_revenue_usd NUMERIC,
  confirmed_payments_count INTEGER,
  partner_commission_accrued_usd NUMERIC,
  partner_commission_paid_usd NUMERIC,
  partner_commission_balance_usd NUMERIC,
  override_commission_accrued_usd NUMERIC,
  override_commission_paid_usd NUMERIC,
  override_commission_balance_usd NUMERIC,
  operating_expenses_usd NUMERIC,
  net_profit_usd NUMERIC,
  cash_owed_usd NUMERIC
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
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
    SELECT COALESCE(SUM(amount_usd), 0) AS total
    FROM public.partner_payouts
    WHERE paid_at >= v_from AND paid_at < v_to
  ),
  ovr_acc AS (
    SELECT COALESCE(SUM(amount_usd), 0) AS total
    FROM public.partner_override_earnings e
    JOIN public.payments p ON p.id = e.payment_id
    WHERE e.status = 'accrued'
      AND p.created_at >= v_from AND p.created_at < v_to
  ),
  ovr_paid AS (
    SELECT COALESCE(SUM(amount_usd), 0) AS total
    FROM public.partner_override_payouts
    WHERE paid_at >= v_from AND paid_at < v_to
  ),
  exp AS (
    SELECT COALESCE(SUM(amount_usd), 0) AS total
    FROM public.operating_expenses
    WHERE occurred_on >= v_from_d AND occurred_on <= v_to_d
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
$$;

-- =========================
-- finance_monthly_series RPC
-- =========================
CREATE OR REPLACE FUNCTION public.finance_monthly_series(p_from TIMESTAMPTZ DEFAULT NULL, p_to TIMESTAMPTZ DEFAULT NULL)
RETURNS TABLE(
  month DATE,
  revenue_usd NUMERIC,
  discounts_usd NUMERIC,
  commissions_usd NUMERIC,
  overrides_usd NUMERIC,
  expenses_usd NUMERIC,
  net_profit_usd NUMERIC
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from TIMESTAMPTZ := COALESCE(p_from, (SELECT date_trunc('month', MIN(created_at)) FROM public.payments WHERE status='confirmed'));
  v_to TIMESTAMPTZ := COALESCE(p_to, now() + interval '1 day');
BEGIN
  IF NOT has_role('admin'::app_role) THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;

  v_from := COALESCE(v_from, date_trunc('month', now()));

  RETURN QUERY
  WITH months AS (
    SELECT generate_series(date_trunc('month', v_from), date_trunc('month', v_to), interval '1 month')::date AS m
  ),
  rev AS (
    SELECT date_trunc('month', created_at)::date AS m,
           SUM(amount_usd) AS gross,
           SUM(discount_amount_usd) AS disc
    FROM public.payments
    WHERE status='confirmed' AND created_at >= v_from AND created_at < v_to
    GROUP BY 1
  ),
  comm AS (
    SELECT date_trunc('month', p.created_at)::date AS m,
           SUM(
             COALESCE(p.commission_base_usd_snapshot,
                      public.payment_commission_base_usd(p.plan_id, p.amount_usd))
             * COALESCE(p.commission_pct_snapshot, pr.commission_pct) / 100.0
           ) AS total
    FROM public.payments p
    JOIN public.partner_attributions a ON a.user_id = p.user_id
    JOIN public.partners pr ON pr.id = a.partner_id
    WHERE p.status='confirmed' AND p.created_at >= v_from AND p.created_at < v_to
    GROUP BY 1
  ),
  ovr AS (
    SELECT date_trunc('month', p.created_at)::date AS m,
           SUM(e.amount_usd) AS total
    FROM public.partner_override_earnings e
    JOIN public.payments p ON p.id = e.payment_id
    WHERE e.status='accrued' AND p.created_at >= v_from AND p.created_at < v_to
    GROUP BY 1
  ),
  exp AS (
    SELECT date_trunc('month', occurred_on)::date AS m,
           SUM(amount_usd) AS total
    FROM public.operating_expenses
    WHERE occurred_on >= v_from::date AND occurred_on <= v_to::date
    GROUP BY 1
  )
  SELECT
    months.m,
    COALESCE(rev.gross, 0),
    COALESCE(rev.disc, 0),
    COALESCE(comm.total, 0),
    COALESCE(ovr.total, 0),
    COALESCE(exp.total, 0),
    COALESCE(rev.gross,0) - COALESCE(rev.disc,0) - COALESCE(comm.total,0) - COALESCE(ovr.total,0) - COALESCE(exp.total,0)
  FROM months
  LEFT JOIN rev ON rev.m = months.m
  LEFT JOIN comm ON comm.m = months.m
  LEFT JOIN ovr ON ovr.m = months.m
  LEFT JOIN exp ON exp.m = months.m
  ORDER BY months.m;
END;
$$;

-- =========================
-- finance_partner_rollup RPC
-- =========================
CREATE OR REPLACE FUNCTION public.finance_partner_rollup(p_from TIMESTAMPTZ DEFAULT NULL, p_to TIMESTAMPTZ DEFAULT NULL)
RETURNS TABLE(
  partner_id UUID,
  code TEXT,
  display_name TEXT,
  commission_pct NUMERIC,
  is_active BOOLEAN,
  parent_partner_id UUID,
  referred_users INTEGER,
  confirmed_payments INTEGER,
  gross_earnings_usd NUMERIC,
  paid_out_usd NUMERIC,
  balance_owed_usd NUMERIC,
  override_earned_usd NUMERIC,
  override_paid_usd NUMERIC,
  override_balance_usd NUMERIC,
  downline_count INTEGER
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from TIMESTAMPTZ := COALESCE(p_from, '1970-01-01'::timestamptz);
  v_to TIMESTAMPTZ := COALESCE(p_to, now() + interval '1 day');
BEGIN
  IF NOT has_role('admin'::app_role) THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    pr.id,
    pr.code,
    pr.display_name,
    pr.commission_pct,
    pr.is_active,
    pr.parent_partner_id,
    COALESCE((SELECT COUNT(*)::INT FROM public.partner_attributions a WHERE a.partner_id = pr.id), 0),
    COALESCE((SELECT COUNT(*)::INT FROM public.payments p
              JOIN public.partner_attributions a ON a.user_id = p.user_id
              WHERE a.partner_id = pr.id AND p.status='confirmed'
                AND p.created_at >= v_from AND p.created_at < v_to), 0),
    COALESCE((SELECT ROUND(SUM(
                COALESCE(p.commission_base_usd_snapshot,
                         public.payment_commission_base_usd(p.plan_id, p.amount_usd))
                * COALESCE(p.commission_pct_snapshot, pr.commission_pct) / 100.0
              ), 2)
              FROM public.payments p
              JOIN public.partner_attributions a ON a.user_id = p.user_id
              WHERE a.partner_id = pr.id AND p.status='confirmed'
                AND p.created_at >= v_from AND p.created_at < v_to), 0),
    COALESCE((SELECT SUM(amount_usd) FROM public.partner_payouts po
              WHERE po.partner_id = pr.id AND po.paid_at >= v_from AND po.paid_at < v_to), 0),
    0::NUMERIC, -- balance computed below
    COALESCE((SELECT SUM(e.amount_usd) FROM public.partner_override_earnings e
              JOIN public.payments p ON p.id = e.payment_id
              WHERE e.beneficiary_partner_id = pr.id AND e.status='accrued'
                AND p.created_at >= v_from AND p.created_at < v_to), 0),
    COALESCE((SELECT SUM(amount_usd) FROM public.partner_override_payouts op
              WHERE op.partner_id = pr.id AND op.paid_at >= v_from AND op.paid_at < v_to), 0),
    0::NUMERIC,
    COALESCE((SELECT COUNT(DISTINCT e.source_partner_id)::INT
              FROM public.partner_override_earnings e
              WHERE e.beneficiary_partner_id = pr.id), 0)
  FROM public.partners pr
  ORDER BY pr.code;
END;
$$;
