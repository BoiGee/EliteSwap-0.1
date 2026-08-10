-- Enrich attach_partner_code to surface the existing partner code on conflict
CREATE OR REPLACE FUNCTION public.attach_partner_code(p_code TEXT, p_source TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_partner RECORD;
  v_existing TEXT;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF p_source NOT IN ('link','signup_code','dashboard_code') THEN
    RAISE EXCEPTION 'Invalid source';
  END IF;

  SELECT p.code INTO v_existing
  FROM public.partner_attributions a
  JOIN public.partners p ON p.id = a.partner_id
  WHERE a.user_id = v_uid;

  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_attributed', 'existing_code', v_existing);
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

-- Per-payment commission breakdown
CREATE OR REPLACE FUNCTION public.partner_commission_breakdown(p_partner_id UUID)
RETURNS TABLE(
  payment_id UUID,
  user_id UUID,
  email_masked TEXT,
  plan_name TEXT,
  plan_price_usd NUMERIC,
  amount_paid_usd NUMERIC,
  commission_usd NUMERIC,
  status TEXT,
  created_at TIMESTAMPTZ
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
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
         THEN ROUND(pp.price_usd * v_pct / 100.0, 2)
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
$$;