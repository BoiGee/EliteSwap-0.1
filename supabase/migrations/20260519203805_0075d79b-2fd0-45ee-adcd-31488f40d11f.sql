CREATE OR REPLACE FUNCTION public.partner_override_stats(p_partner_id uuid)
 RETURNS TABLE(downline_count integer, override_earnings_usd numeric, override_paid_out_usd numeric, override_balance_usd numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    SELECT COUNT(*)::int AS c
    FROM public.partner_override_earnings
    WHERE beneficiary_partner_id = p_partner_id
  )
  SELECT downline.c, earned.total, paid.total, earned.total - paid.total
  FROM earned, paid, downline;
END;
$function$;