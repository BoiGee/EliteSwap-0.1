-- 1. Extend partners with parent + override pct
ALTER TABLE public.partners
  ADD COLUMN IF NOT EXISTS parent_partner_id uuid NULL REFERENCES public.partners(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS override_pct numeric NOT NULL DEFAULT 5;

CREATE INDEX IF NOT EXISTS idx_partners_parent ON public.partners(parent_partner_id);

-- 2. Cycle guard trigger
CREATE OR REPLACE FUNCTION public.tg_partners_guard_cycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_cur uuid;
  v_depth int := 0;
BEGIN
  IF NEW.parent_partner_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.parent_partner_id = NEW.id THEN
    RAISE EXCEPTION 'Partner cannot be its own parent';
  END IF;
  v_cur := NEW.parent_partner_id;
  WHILE v_cur IS NOT NULL AND v_depth < 50 LOOP
    IF v_cur = NEW.id THEN
      RAISE EXCEPTION 'Cycle detected in partner parent chain';
    END IF;
    SELECT parent_partner_id INTO v_cur FROM public.partners WHERE id = v_cur;
    v_depth := v_depth + 1;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS partners_guard_cycle ON public.partners;
CREATE TRIGGER partners_guard_cycle
BEFORE INSERT OR UPDATE OF parent_partner_id ON public.partners
FOR EACH ROW EXECUTE FUNCTION public.tg_partners_guard_cycle();

-- 3. Override earnings ledger
CREATE TABLE IF NOT EXISTS public.partner_override_earnings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL,
  source_partner_id uuid NOT NULL REFERENCES public.partners(id) ON DELETE CASCADE,
  beneficiary_partner_id uuid NOT NULL REFERENCES public.partners(id) ON DELETE CASCADE,
  depth int NOT NULL,
  commission_base_usd numeric NOT NULL,
  override_pct numeric NOT NULL,
  amount_usd numeric NOT NULL,
  status text NOT NULL DEFAULT 'accrued',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id, beneficiary_partner_id)
);

CREATE INDEX IF NOT EXISTS idx_poe_beneficiary ON public.partner_override_earnings(beneficiary_partner_id, status);
CREATE INDEX IF NOT EXISTS idx_poe_payment ON public.partner_override_earnings(payment_id);

ALTER TABLE public.partner_override_earnings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage override earnings"
  ON public.partner_override_earnings FOR ALL TO authenticated
  USING (has_role('admin'::app_role)) WITH CHECK (has_role('admin'::app_role));

CREATE POLICY "Beneficiary can view own override earnings"
  ON public.partner_override_earnings FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.partners p
    WHERE p.id = partner_override_earnings.beneficiary_partner_id
      AND p.user_id = auth.uid()
  ));

CREATE TRIGGER trg_poe_updated_at
BEFORE UPDATE ON public.partner_override_earnings
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 4. Override payouts
CREATE TABLE IF NOT EXISTS public.partner_override_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES public.partners(id) ON DELETE CASCADE,
  amount_usd numeric NOT NULL,
  note text,
  paid_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pop_partner ON public.partner_override_payouts(partner_id);

ALTER TABLE public.partner_override_payouts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage override payouts"
  ON public.partner_override_payouts FOR ALL TO authenticated
  USING (has_role('admin'::app_role)) WITH CHECK (has_role('admin'::app_role));

CREATE POLICY "Beneficiary can view own override payouts"
  ON public.partner_override_payouts FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.partners p
    WHERE p.id = partner_override_payouts.partner_id
      AND p.user_id = auth.uid()
  ));

-- 5. Trigger to write/void override ledger entries when payments change status
CREATE OR REPLACE FUNCTION public.tg_payments_write_override_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_direct_partner_id uuid;
  v_base numeric;
  v_cur uuid;
  v_depth int := 0;
  v_pct numeric;
BEGIN
  -- Status flipped TO confirmed: create override rows
  IF (TG_OP = 'INSERT' AND NEW.status = 'confirmed')
     OR (TG_OP = 'UPDATE' AND NEW.status = 'confirmed' AND COALESCE(OLD.status,'') <> 'confirmed') THEN

    SELECT p.id INTO v_direct_partner_id
    FROM public.partner_attributions a
    JOIN public.partners p ON p.id = a.partner_id
    WHERE a.user_id = NEW.user_id;

    IF v_direct_partner_id IS NULL THEN RETURN NEW; END IF;

    v_base := public.payment_commission_base_usd(NEW.plan_id, NEW.amount_usd);
    IF COALESCE(v_base, 0) <= 0 THEN RETURN NEW; END IF;

    -- Walk up the chain starting from the direct partner's parent
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

  -- Status flipped AWAY from confirmed: void rows
  ELSIF TG_OP = 'UPDATE' AND COALESCE(OLD.status,'') = 'confirmed' AND NEW.status <> 'confirmed' THEN
    UPDATE public.partner_override_earnings
      SET status = 'void', updated_at = now()
      WHERE payment_id = NEW.id AND status = 'accrued';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payments_write_override_ledger ON public.payments;
CREATE TRIGGER payments_write_override_ledger
AFTER INSERT OR UPDATE OF status ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.tg_payments_write_override_ledger();

-- On payment delete, void rows (CASCADE not used so audit trail survives; mark void)
CREATE OR REPLACE FUNCTION public.tg_payments_void_overrides_on_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE public.partner_override_earnings
    SET status = 'void', updated_at = now()
    WHERE payment_id = OLD.id AND status = 'accrued';
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS payments_void_overrides_on_delete ON public.payments;
CREATE TRIGGER payments_void_overrides_on_delete
BEFORE DELETE ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.tg_payments_void_overrides_on_delete();

-- 6. Stats RPC for a beneficiary partner
CREATE OR REPLACE FUNCTION public.partner_override_stats(p_partner_id uuid)
RETURNS TABLE(
  downline_count int,
  override_earnings_usd numeric,
  override_paid_out_usd numeric,
  override_balance_usd numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT (has_role('admin'::app_role)
          OR EXISTS (SELECT 1 FROM public.partners WHERE id = p_partner_id AND user_id = auth.uid())) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH earned AS (
    SELECT COALESCE(SUM(amount_usd) FILTER (WHERE status = 'accrued'), 0) AS total
    FROM public.partner_override_earnings
    WHERE beneficiary_partner_id = p_partner_id
  ),
  paid AS (
    SELECT COALESCE(SUM(amount_usd), 0) AS total
    FROM public.partner_override_payouts
    WHERE partner_id = p_partner_id
  ),
  downline AS (
    SELECT COUNT(DISTINCT source_partner_id)::int AS c
    FROM public.partner_override_earnings
    WHERE beneficiary_partner_id = p_partner_id
  )
  SELECT downline.c, earned.total, paid.total, earned.total - paid.total
  FROM earned, paid, downline;
END;
$$;

-- 7. Breakdown RPC (masks source partner identity from beneficiary)
CREATE OR REPLACE FUNCTION public.partner_override_breakdown(p_partner_id uuid)
RETURNS TABLE(
  id uuid,
  payment_id uuid,
  source_label text,
  depth int,
  commission_base_usd numeric,
  override_pct numeric,
  amount_usd numeric,
  status text,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_is_admin boolean;
BEGIN
  v_is_admin := has_role('admin'::app_role);
  IF NOT (v_is_admin
          OR EXISTS (SELECT 1 FROM public.partners WHERE id = p_partner_id AND user_id = auth.uid())) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT
    e.id,
    e.payment_id,
    (CASE WHEN v_is_admin THEN COALESCE(sp.code, 'unknown')
          ELSE 'Downline · L' || e.depth::text END) AS source_label,
    e.depth,
    e.commission_base_usd,
    e.override_pct,
    e.amount_usd,
    e.status,
    e.created_at
  FROM public.partner_override_earnings e
  LEFT JOIN public.partners sp ON sp.id = e.source_partner_id
  WHERE e.beneficiary_partner_id = p_partner_id
  ORDER BY e.created_at DESC;
END;
$$;

-- 8. Admin: set parent with cycle check baked in via the existing trigger
CREATE OR REPLACE FUNCTION public.admin_set_partner_parent(p_partner_id uuid, p_parent_partner_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT has_role('admin'::app_role) THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;
  UPDATE public.partners
    SET parent_partner_id = p_parent_partner_id,
        updated_at = now()
    WHERE id = p_partner_id;
END;
$$;