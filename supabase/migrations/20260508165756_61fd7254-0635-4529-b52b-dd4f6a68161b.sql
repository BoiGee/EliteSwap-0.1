-- Add 'partner' to app_role enum
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'partner';

-- partners
CREATE TABLE public.partners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,
  display_name TEXT,
  commission_pct NUMERIC NOT NULL DEFAULT 30,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.partners_normalize()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.code := upper(trim(NEW.code));
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER partners_normalize_trg
BEFORE INSERT OR UPDATE ON public.partners
FOR EACH ROW EXECUTE FUNCTION public.partners_normalize();

ALTER TABLE public.partners ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage partners" ON public.partners
FOR ALL TO authenticated
USING (has_role('admin'::app_role)) WITH CHECK (has_role('admin'::app_role));

CREATE POLICY "Partner can view own row" ON public.partners
FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- partner_attributions
CREATE TABLE public.partner_attributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE,
  partner_id UUID NOT NULL REFERENCES public.partners(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('link','signup_code','dashboard_code','admin')),
  attributed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_partner_attr_partner ON public.partner_attributions(partner_id);

ALTER TABLE public.partner_attributions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage attributions" ON public.partner_attributions
FOR ALL TO authenticated
USING (has_role('admin'::app_role)) WITH CHECK (has_role('admin'::app_role));

CREATE POLICY "User can view own attribution" ON public.partner_attributions
FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Partner can view own referrals" ON public.partner_attributions
FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.partners p WHERE p.id = partner_attributions.partner_id AND p.user_id = auth.uid()));

-- partner_payouts
CREATE TABLE public.partner_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES public.partners(id) ON DELETE CASCADE,
  amount_usd NUMERIC NOT NULL CHECK (amount_usd > 0),
  note TEXT,
  paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_partner_payouts_partner ON public.partner_payouts(partner_id);

ALTER TABLE public.partner_payouts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage payouts" ON public.partner_payouts
FOR ALL TO authenticated
USING (has_role('admin'::app_role)) WITH CHECK (has_role('admin'::app_role));

CREATE POLICY "Partner can view own payouts" ON public.partner_payouts
FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.partners p WHERE p.id = partner_payouts.partner_id AND p.user_id = auth.uid()));

-- attach_partner_code: user self-attribution
CREATE OR REPLACE FUNCTION public.attach_partner_code(p_code TEXT, p_source TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_partner RECORD;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF p_source NOT IN ('link','signup_code','dashboard_code') THEN
    RAISE EXCEPTION 'Invalid source';
  END IF;
  IF EXISTS (SELECT 1 FROM public.partner_attributions WHERE user_id = v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_attributed');
  END IF;
  SELECT * INTO v_partner FROM public.partners
   WHERE code = upper(trim(p_code)) AND is_active = true;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_code');
  END IF;
  IF v_partner.user_id = v_uid THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'self_referral');
  END IF;
  INSERT INTO public.partner_attributions (user_id, partner_id, source)
  VALUES (v_uid, v_partner.id, p_source);
  RETURN jsonb_build_object('ok', true, 'partner_code', v_partner.code);
END;
$$;

-- admin override
CREATE OR REPLACE FUNCTION public.admin_set_partner_for_user(p_user_id UUID, p_partner_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT has_role('admin'::app_role) THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;
  IF p_partner_id IS NULL THEN
    DELETE FROM public.partner_attributions WHERE user_id = p_user_id;
  ELSE
    INSERT INTO public.partner_attributions (user_id, partner_id, source)
    VALUES (p_user_id, p_partner_id, 'admin')
    ON CONFLICT (user_id) DO UPDATE
      SET partner_id = EXCLUDED.partner_id, source = 'admin', attributed_at = now();
  END IF;
END;
$$;

-- partner_stats
CREATE OR REPLACE FUNCTION public.partner_stats(p_partner_id UUID)
RETURNS TABLE(
  referred_users INT,
  confirmed_payments INT,
  gross_earnings_usd NUMERIC,
  paid_out_usd NUMERIC,
  balance_owed_usd NUMERIC,
  commission_pct NUMERIC
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
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
    SELECT pmt.id, pmt.plan_id, pp.price_usd
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
    COALESCE(ROUND(SUM(pay.price_usd) * v_pct / 100.0, 2), 0),
    (SELECT total FROM payout),
    COALESCE(ROUND(SUM(pay.price_usd) * v_pct / 100.0, 2), 0) - (SELECT total FROM payout),
    v_pct
  FROM pay;
END;
$$;

-- partner_referrals
CREATE OR REPLACE FUNCTION public.partner_referrals(p_partner_id UUID)
RETURNS TABLE(
  user_id UUID,
  email_masked TEXT,
  display_name TEXT,
  attributed_at TIMESTAMPTZ,
  source TEXT,
  confirmed_payments INT,
  total_commission_usd NUMERIC,
  last_payment_status TEXT,
  last_payment_at TIMESTAMPTZ
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
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
    COALESCE((SELECT ROUND(SUM(pp.price_usd) * v_pct / 100.0, 2)
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
$$;

-- Updated-at trigger for partners
CREATE TRIGGER partners_updated_at
BEFORE UPDATE ON public.partners
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();