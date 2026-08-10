-- Backfill function: rebuilds override ledger rows for a partner (or all when NULL)
CREATE OR REPLACE FUNCTION public.admin_rebuild_override_ledger(p_source_partner_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
    SELECT pmt.id AS payment_id, pmt.plan_id, pmt.amount_usd, p.id AS direct_partner_id, p.parent_partner_id
    FROM public.payments pmt
    JOIN public.partner_attributions a ON a.user_id = pmt.user_id
    JOIN public.partners p ON p.id = a.partner_id
    WHERE pmt.status = 'confirmed'
      AND p.parent_partner_id IS NOT NULL
      AND (p_source_partner_id IS NULL OR p.id = p_source_partner_id)
  LOOP
    v_base := public.payment_commission_base_usd(r.plan_id, r.amount_usd);
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
$$;

-- Trigger: when a partner's parent changes, auto-backfill override ledger for that partner's confirmed payments
CREATE OR REPLACE FUNCTION public.tg_partners_backfill_overrides_on_parent_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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

  -- Void existing rows whose beneficiary is no longer in the new ancestor chain
  UPDATE public.partner_override_earnings
    SET status = 'void', updated_at = now()
    WHERE source_partner_id = NEW.id
      AND status = 'accrued';

  IF NEW.parent_partner_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_pct := COALESCE(NEW.override_pct, 5);

  FOR r IN
    SELECT pmt.id AS payment_id, pmt.plan_id, pmt.amount_usd
    FROM public.payments pmt
    JOIN public.partner_attributions a ON a.user_id = pmt.user_id
    WHERE a.partner_id = NEW.id AND pmt.status = 'confirmed'
  LOOP
    v_base := public.payment_commission_base_usd(r.plan_id, r.amount_usd);
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
$$;

DROP TRIGGER IF EXISTS partners_backfill_overrides ON public.partners;
CREATE TRIGGER partners_backfill_overrides
AFTER UPDATE OF parent_partner_id ON public.partners
FOR EACH ROW EXECUTE FUNCTION public.tg_partners_backfill_overrides_on_parent_change();

-- One-time backfill for any already-confirmed payments
DO $$
DECLARE
  r RECORD;
  v_cur uuid;
  v_depth int;
  v_pct numeric;
  v_base numeric;
BEGIN
  FOR r IN
    SELECT pmt.id AS payment_id, pmt.plan_id, pmt.amount_usd,
           p.id AS direct_partner_id, p.parent_partner_id, COALESCE(p.override_pct, 5) AS pct
    FROM public.payments pmt
    JOIN public.partner_attributions a ON a.user_id = pmt.user_id
    JOIN public.partners p ON p.id = a.partner_id
    WHERE pmt.status = 'confirmed' AND p.parent_partner_id IS NOT NULL
  LOOP
    v_base := public.payment_commission_base_usd(r.plan_id, r.amount_usd);
    IF COALESCE(v_base, 0) <= 0 THEN CONTINUE; END IF;
    v_cur := r.parent_partner_id;
    v_depth := 0;
    WHILE v_cur IS NOT NULL AND v_depth < 20 LOOP
      v_depth := v_depth + 1;
      INSERT INTO public.partner_override_earnings
        (payment_id, source_partner_id, beneficiary_partner_id, depth,
         commission_base_usd, override_pct, amount_usd, status)
      VALUES
        (r.payment_id, r.direct_partner_id, v_cur, v_depth,
         v_base, r.pct, ROUND(v_base * r.pct / 100.0, 2), 'accrued')
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
END;
$$;