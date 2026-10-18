-- The partner page showed "Plan price $210" next to "Commission $25.20" under "40% of plan price",
-- which reads as underpaid: commission is 40% of the plan's shared profit ($63), not its price.
-- Return the base and percentage actually used so each row shows the arithmetic.

DROP FUNCTION IF EXISTS public.partner_commission_breakdown(uuid);

CREATE FUNCTION public.partner_commission_breakdown(p_partner_id uuid)
RETURNS TABLE(payment_id uuid, user_id uuid, email_masked text, plan_name text, plan_price_usd numeric, amount_paid_usd numeric, commission_base_usd numeric, commission_pct numeric, commission_usd numeric, status text, created_at timestamp with time zone)
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
      COALESCE(pmt.commission_pct_snapshot, v_pct) AS eff_pct
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
    r.base_usd,
    r.eff_pct,
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

REVOKE ALL ON FUNCTION public.partner_commission_breakdown(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_commission_breakdown(uuid) TO authenticated;
