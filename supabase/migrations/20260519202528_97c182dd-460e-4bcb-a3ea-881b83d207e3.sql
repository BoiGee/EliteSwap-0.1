
-- 1. Add snapshot column to payments
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS commission_base_usd_snapshot numeric;

-- 2. Backfill snapshot for already-confirmed payments using CURRENT base (freezes history)
UPDATE public.payments
   SET commission_base_usd_snapshot = public.payment_commission_base_usd(plan_id, amount_usd)
 WHERE status = 'confirmed'
   AND commission_base_usd_snapshot IS NULL;

-- 3. Update pricing_plans commission_base_usd to new fixed values
UPDATE public.pricing_plans SET commission_base_usd = 43  WHERE name = 'Basic';
UPDATE public.pricing_plans SET commission_base_usd = 50  WHERE name = 'Professional';
UPDATE public.pricing_plans SET commission_base_usd = 200 WHERE name = 'Enterprise';

-- 4. Update confirm trigger to snapshot base on first confirmation
CREATE OR REPLACE FUNCTION public.tg_payments_normalize_partner_credit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_plan_price numeric;
  v_matched_plan_id uuid;
  v_partner_pct numeric;
  v_base numeric;
BEGIN
  IF NEW.plan_id IS NOT NULL AND NEW.amount_usd IS NULL THEN
    SELECT pp.price_usd INTO v_plan_price FROM public.pricing_plans pp WHERE pp.id = NEW.plan_id;
    IF v_plan_price IS NOT NULL THEN NEW.amount_usd := v_plan_price; END IF;
  END IF;

  IF NEW.plan_id IS NULL AND NEW.amount_usd IS NOT NULL THEN
    SELECT pp.id INTO v_matched_plan_id
    FROM public.pricing_plans pp
    WHERE pp.is_active = true AND pp.price_usd = NEW.amount_usd
    ORDER BY pp.sort_order LIMIT 1;
    IF v_matched_plan_id IS NOT NULL THEN NEW.plan_id := v_matched_plan_id; END IF;
  END IF;

  IF NEW.status = 'confirmed' THEN
    SELECT pr.commission_pct INTO v_partner_pct
    FROM public.partner_attributions a
    JOIN public.partners pr ON pr.id = a.partner_id
    WHERE a.user_id = NEW.user_id;

    IF v_partner_pct IS NOT NULL THEN
      IF NEW.plan_id IS NULL AND NEW.amount_usd IS NULL THEN
        RAISE EXCEPTION 'Partner payment must include a plan or amount before it can be confirmed.' USING ERRCODE = '23514';
      END IF;
      v_base := public.payment_commission_base_usd(NEW.plan_id, NEW.amount_usd);
      IF COALESCE(v_base, 0) <= 0 THEN
        RAISE EXCEPTION 'Partner payment could not resolve a commission amount.' USING ERRCODE = '23514';
      END IF;
      IF NEW.commission_pct_snapshot IS NULL THEN
        NEW.commission_pct_snapshot := v_partner_pct;
      END IF;
    END IF;

    -- Snapshot commission base on first confirmation so future plan base changes
    -- don't affect this payment's historical totals.
    IF NEW.commission_base_usd_snapshot IS NULL THEN
      NEW.commission_base_usd_snapshot := public.payment_commission_base_usd(NEW.plan_id, NEW.amount_usd);
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

-- 5. Override ledger writer: prefer snapshot
CREATE OR REPLACE FUNCTION public.tg_payments_write_override_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_direct_partner_id uuid;
  v_base numeric;
  v_cur uuid;
  v_depth int := 0;
  v_pct numeric;
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.status = 'confirmed')
     OR (TG_OP = 'UPDATE' AND NEW.status = 'confirmed' AND COALESCE(OLD.status,'') <> 'confirmed') THEN

    SELECT p.id INTO v_direct_partner_id
    FROM public.partner_attributions a
    JOIN public.partners p ON p.id = a.partner_id
    WHERE a.user_id = NEW.user_id;

    IF v_direct_partner_id IS NULL THEN RETURN NEW; END IF;

    v_base := COALESCE(NEW.commission_base_usd_snapshot,
                       public.payment_commission_base_usd(NEW.plan_id, NEW.amount_usd));
    IF COALESCE(v_base, 0) <= 0 THEN RETURN NEW; END IF;

    SELECT parent_partner_id INTO v_cur FROM public.partners WHERE id = v_direct_partner_id;

    WHILE v_cur IS NOT NULL AND v_depth < 20 LOOP
      v_depth := v_depth + 1;
      SELECT override_pct INTO v_pct FROM public.partners WHERE id = v_direct_partner_id;
      v_pct := COALESCE(v_pct, 5);

      INSERT INTO public.partner_override_earnings
        (payment_id, source_partner_id, beneficiary_partner_id, depth,
         commission_base_usd, override_pct, amount_usd, status)
      VALUES
        (NEW.id, v_direct_partner_id, v_cur, v_depth,
         v_base, v_pct, ROUND(v_base * v_pct / 100.0, 2), 'accrued')
      ON CONFLICT (payment_id, beneficiary_partner_id) DO UPDATE
        SET status = 'accrued',
            commission_base_usd = EXCLUDED.commission_base_usd,
            override_pct = EXCLUDED.override_pct,
            amount_usd = EXCLUDED.amount_usd,
            updated_at = now();

      SELECT parent_partner_id INTO v_cur FROM public.partners WHERE id = v_cur;
    END LOOP;

  ELSIF TG_OP = 'UPDATE' AND COALESCE(OLD.status,'') = 'confirmed' AND NEW.status <> 'confirmed' THEN
    UPDATE public.partner_override_earnings
      SET status = 'void', updated_at = now()
      WHERE payment_id = NEW.id AND status = 'accrued';
  END IF;

  RETURN NEW;
END;
$function$;

-- 6. admin_rebuild_override_ledger: prefer snapshot
CREATE OR REPLACE FUNCTION public.admin_rebuild_override_ledger(p_source_partner_id uuid DEFAULT NULL::uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r RECORD;
  v_cur uuid;
  v_depth int;
  v_pct numeric;
  v_base numeric;
  v_count int := 0;
BEGIN
  IF NOT has_role('admin'::app_role) THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;

  FOR r IN
    SELECT pmt.id AS payment_id, pmt.plan_id, pmt.amount_usd,
           pmt.commission_base_usd_snapshot AS snap,
           p.id AS direct_partner_id, p.parent_partner_id
    FROM public.payments pmt
    JOIN public.partner_attributions a ON a.user_id = pmt.user_id
    JOIN public.partners p ON p.id = a.partner_id
    WHERE pmt.status = 'confirmed'
      AND p.parent_partner_id IS NOT NULL
      AND (p_source_partner_id IS NULL OR p.id = p_source_partner_id)
  LOOP
    v_base := COALESCE(r.snap, public.payment_commission_base_usd(r.plan_id, r.amount_usd));
    IF COALESCE(v_base, 0) <= 0 THEN CONTINUE; END IF;

    SELECT override_pct INTO v_pct FROM public.partners WHERE id = r.direct_partner_id;
    v_pct := COALESCE(v_pct, 5);

    v_cur := r.parent_partner_id;
    v_depth := 0;
    WHILE v_cur IS NOT NULL AND v_depth < 20 LOOP
      v_depth := v_depth + 1;

      INSERT INTO public.partner_override_earnings
        (payment_id, source_partner_id, beneficiary_partner_id, depth,
         commission_base_usd, override_pct, amount_usd, status)
      VALUES
        (r.payment_id, r.direct_partner_id, v_cur, v_depth,
         v_base, v_pct, ROUND(v_base * v_pct / 100.0, 2), 'accrued')
      ON CONFLICT (payment_id, beneficiary_partner_id) DO UPDATE
        SET status = 'accrued',
            commission_base_usd = EXCLUDED.commission_base_usd,
            override_pct = EXCLUDED.override_pct,
            amount_usd = EXCLUDED.amount_usd,
            depth = EXCLUDED.depth,
            updated_at = now();

      v_count := v_count + 1;
      SELECT parent_partner_id INTO v_cur FROM public.partners WHERE id = v_cur;
    END LOOP;
  END LOOP;

  RETURN v_count;
END;
$function$;

-- 7. Parent-change backfill: prefer snapshot
CREATE OR REPLACE FUNCTION public.tg_partners_backfill_overrides_on_parent_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r RECORD;
  v_cur uuid;
  v_depth int;
  v_pct numeric;
  v_base numeric;
BEGIN
  IF COALESCE(NEW.parent_partner_id::text,'') = COALESCE(OLD.parent_partner_id::text,'') THEN
    RETURN NEW;
  END IF;

  UPDATE public.partner_override_earnings
    SET status = 'void', updated_at = now()
    WHERE source_partner_id = NEW.id
      AND status = 'accrued';

  IF NEW.parent_partner_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_pct := COALESCE(NEW.override_pct, 5);

  FOR r IN
    SELECT pmt.id AS payment_id, pmt.plan_id, pmt.amount_usd,
           pmt.commission_base_usd_snapshot AS snap
    FROM public.payments pmt
    JOIN public.partner_attributions a ON a.user_id = pmt.user_id
    WHERE a.partner_id = NEW.id AND pmt.status = 'confirmed'
  LOOP
    v_base := COALESCE(r.snap, public.payment_commission_base_usd(r.plan_id, r.amount_usd));
    IF COALESCE(v_base, 0) <= 0 THEN CONTINUE; END IF;

    v_cur := NEW.parent_partner_id;
    v_depth := 0;
    WHILE v_cur IS NOT NULL AND v_depth < 20 LOOP
      v_depth := v_depth + 1;
      INSERT INTO public.partner_override_earnings
        (payment_id, source_partner_id, beneficiary_partner_id, depth,
         commission_base_usd, override_pct, amount_usd, status)
      VALUES
        (r.payment_id, NEW.id, v_cur, v_depth,
         v_base, v_pct, ROUND(v_base * v_pct / 100.0, 2), 'accrued')
      ON CONFLICT (payment_id, beneficiary_partner_id) DO UPDATE
        SET status = 'accrued',
            commission_base_usd = EXCLUDED.commission_base_usd,
            override_pct = EXCLUDED.override_pct,
            amount_usd = EXCLUDED.amount_usd,
            depth = EXCLUDED.depth,
            updated_at = now();
      SELECT parent_partner_id INTO v_cur FROM public.partners WHERE id = v_cur;
    END LOOP;
  END LOOP;

  RETURN NEW;
END;
$function$;

-- 8. Read RPCs: prefer snapshot
CREATE OR REPLACE FUNCTION public.partner_commission_breakdown(p_partner_id uuid)
RETURNS TABLE(payment_id uuid, user_id uuid, email_masked text, plan_name text, plan_price_usd numeric, amount_paid_usd numeric, commission_usd numeric, status text, created_at timestamp with time zone)
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
      COALESCE(pp.name, pp_amt.name, 'Custom payment') AS plan_name,
      COALESCE(pp.price_usd, pp_amt.price_usd, pmt.amount_usd) AS plan_price,
      COALESCE(pmt.commission_base_usd_snapshot,
               public.payment_commission_base_usd(pmt.plan_id, pmt.amount_usd)) AS base_usd,
      v_pct AS eff_pct
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

CREATE OR REPLACE FUNCTION public.partner_referrals(p_partner_id uuid)
RETURNS TABLE(user_id uuid, email_masked text, display_name text, attributed_at timestamp with time zone, source text, confirmed_payments integer, total_commission_usd numeric, last_payment_status text, last_payment_at timestamp with time zone)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
    a.user_id,
    (CASE WHEN v_is_admin THEN COALESCE(pr.email,'')
         ELSE COALESCE(regexp_replace(pr.email, '^(.).+(@.+)$', '\1***\2'), 'unknown')
    END),
    pr.display_name,
    a.attributed_at,
    a.source,
    COALESCE((SELECT COUNT(*)::INT FROM public.payments p2 WHERE p2.user_id = a.user_id AND p2.status='confirmed'),0),
    COALESCE((
      SELECT ROUND(SUM(
        COALESCE(p2.commission_base_usd_snapshot,
                 public.payment_commission_base_usd(p2.plan_id, p2.amount_usd))
        * v_pct / 100.0
      ), 2)
      FROM public.payments p2
      WHERE p2.user_id = a.user_id AND p2.status='confirmed'
    ), 0),
    (SELECT p2.status FROM public.payments p2 WHERE p2.user_id = a.user_id ORDER BY p2.created_at DESC LIMIT 1),
    (SELECT p2.created_at FROM public.payments p2 WHERE p2.user_id = a.user_id ORDER BY p2.created_at DESC LIMIT 1)
  FROM public.partner_attributions a
  LEFT JOIN public.profiles pr ON pr.user_id = a.user_id
  WHERE a.partner_id = p_partner_id
  ORDER BY a.attributed_at DESC;
END;
$function$;

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
    SELECT pmt.id,
           COALESCE(pmt.commission_base_usd_snapshot,
                    public.payment_commission_base_usd(pmt.plan_id, pmt.amount_usd)) AS base_usd,
           v_pct AS eff_pct
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
    COALESCE(ROUND(SUM(pay.base_usd * pay.eff_pct / 100.0), 2), 0),
    (SELECT total FROM payout),
    COALESCE(ROUND(SUM(pay.base_usd * pay.eff_pct / 100.0), 2), 0) - (SELECT total FROM payout),
    v_pct
  FROM pay;
END;
$function$;
