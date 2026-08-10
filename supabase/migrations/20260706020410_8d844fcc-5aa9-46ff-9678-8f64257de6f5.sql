
-- =========================================================================
-- R1: Fix multi-level override commission — use each beneficiary's own pct
-- =========================================================================

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
      -- Each ancestor earns using THEIR OWN override_pct, not the direct partner's.
      SELECT override_pct INTO v_pct FROM public.partners WHERE id = v_cur;
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

    v_cur := r.parent_partner_id;
    v_depth := 0;
    WHILE v_cur IS NOT NULL AND v_depth < 20 LOOP
      v_depth := v_depth + 1;
      SELECT override_pct INTO v_pct FROM public.partners WHERE id = v_cur;
      v_pct := COALESCE(v_pct, 5);

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
      SELECT override_pct INTO v_pct FROM public.partners WHERE id = v_cur;
      v_pct := COALESCE(v_pct, 5);

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

-- =========================================================================
-- R5: Add missing FK partner_override_earnings.payment_id -> payments(id)
-- =========================================================================
ALTER TABLE public.partner_override_earnings
  ADD CONSTRAINT partner_override_earnings_payment_id_fkey
  FOREIGN KEY (payment_id) REFERENCES public.payments(id) ON DELETE CASCADE;
