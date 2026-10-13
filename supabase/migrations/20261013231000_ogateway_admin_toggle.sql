-- Admin switch for Mobile Money / card checkout, and a 2-minute reconcile so a payment whose
-- webhook never arrives is still confirmed (or closed when it fails or is abandoned).

CREATE OR REPLACE FUNCTION public.admin_set_gateway_checkout(p_enabled boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_before boolean;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT gateway_checkout_enabled INTO v_before FROM public.studio_pricing_config WHERE id = true;
  UPDATE public.studio_pricing_config SET gateway_checkout_enabled = p_enabled, updated_at = now() WHERE id = true;
  PERFORM public.log_admin_action('gateway_checkout_toggle', 'studio_pricing_config', 'true',
    jsonb_build_object('gateway_checkout_enabled', v_before), jsonb_build_object('gateway_checkout_enabled', p_enabled), '{}'::jsonb);
  RETURN p_enabled;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_gateway_checkout(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_gateway_checkout(boolean) TO authenticated;

SELECT cron.unschedule('reconcile-ogateway-payments')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'reconcile-ogateway-payments');
SELECT cron.schedule(
  'reconcile-ogateway-payments',
  '*/2 * * * *',
  $cron$
    SELECT public.cron_invoke_edge('verify-ogateway-payment', '{"mode":"cron"}'::jsonb)
     WHERE EXISTS (SELECT 1 FROM public.payments WHERE payment_method = 'ogateway' AND status = 'pending');
  $cron$
);
