-- 1. Lock down record_discount_redemption to service_role only
REVOKE EXECUTE ON FUNCTION public.record_discount_redemption(TEXT, UUID, UUID, NUMERIC) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_discount_redemption(TEXT, UUID, UUID, NUMERIC) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_discount_redemption(TEXT, UUID, UUID, NUMERIC) TO service_role;

-- 2. Allow users to read their own role row (needed for client-side admin UI checks)
CREATE POLICY "Users can view own role"
ON public.user_roles
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);