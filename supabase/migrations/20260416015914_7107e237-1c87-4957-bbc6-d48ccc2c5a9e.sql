-- Admin can insert API keys for any user (bypasses payment check)
CREATE POLICY "Admins can insert api_keys"
ON public.api_keys
FOR INSERT
TO authenticated
WITH CHECK (has_role('admin'::app_role));

-- Admin can insert payments for any user
CREATE POLICY "Admins can insert payments"
ON public.payments
FOR INSERT
TO authenticated
WITH CHECK (has_role('admin'::app_role));

-- Admin can delete payments
CREATE POLICY "Admins can delete payments"
ON public.payments
FOR DELETE
TO authenticated
USING (has_role('admin'::app_role));

-- Admin can update any profile
CREATE POLICY "Admins can update profiles"
ON public.profiles
FOR UPDATE
TO authenticated
USING (has_role('admin'::app_role));

-- Admin can delete profiles
CREATE POLICY "Admins can delete profiles"
ON public.profiles
FOR DELETE
TO authenticated
USING (has_role('admin'::app_role));