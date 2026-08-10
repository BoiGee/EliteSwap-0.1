
-- 1) Lock studio_pricing_config to admins only
DROP POLICY IF EXISTS "Anyone authenticated can read pricing config" ON public.studio_pricing_config;

REVOKE SELECT, INSERT, UPDATE, DELETE ON public.studio_pricing_config FROM authenticated;
REVOKE SELECT ON public.studio_pricing_config FROM anon;
GRANT ALL ON public.studio_pricing_config TO service_role;

-- Keep the admin-manage policy (created in the previous migration). Re-assert idempotently.
DROP POLICY IF EXISTS "Admins manage pricing config" ON public.studio_pricing_config;
CREATE POLICY "Admins manage pricing config"
  ON public.studio_pricing_config FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Admins still need base table SELECT/UPDATE grants for the policy to actually let them through.
GRANT SELECT, UPDATE ON public.studio_pricing_config TO authenticated;
-- Note: RLS above still gates row visibility to admins only; the grant just permits the operation type.

-- 2) Lock down the credits helper
REVOKE EXECUTE ON FUNCTION public.studio_credits_for_ms(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.studio_credits_for_ms(bigint) FROM anon;
REVOKE EXECUTE ON FUNCTION public.studio_credits_for_ms(bigint) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.studio_credits_for_ms(bigint) TO service_role;
