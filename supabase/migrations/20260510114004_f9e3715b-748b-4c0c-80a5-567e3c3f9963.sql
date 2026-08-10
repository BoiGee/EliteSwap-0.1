DROP FUNCTION IF EXISTS public.admin_set_payment_status(uuid, text);

REVOKE ALL ON FUNCTION public.admin_set_payment_status(uuid, text, uuid, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_payment_status(uuid, text, uuid, numeric) TO authenticated;

REVOKE ALL ON FUNCTION public.payment_commission_base_usd(uuid, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payment_commission_base_usd(uuid, numeric) TO authenticated;

REVOKE ALL ON FUNCTION public.tg_payments_normalize_partner_credit() FROM PUBLIC;

REVOKE ALL ON FUNCTION public.partner_stats(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.partner_stats(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.partner_referrals(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.partner_referrals(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.partner_commission_breakdown(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.partner_commission_breakdown(uuid) TO authenticated;