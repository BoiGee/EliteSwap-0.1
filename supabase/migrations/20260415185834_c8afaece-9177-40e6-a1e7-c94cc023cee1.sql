
-- Fix 1: Users can only insert payments with status='pending'
DROP POLICY "Users can insert own payments" ON public.payments;
CREATE POLICY "Users can insert own payments" ON public.payments
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND status = 'pending');

-- Fix 2: API key generation requires confirmed payment
DROP POLICY "Users can insert own api_keys" ON public.api_keys;
CREATE POLICY "Users can insert own api_keys" ON public.api_keys
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = user_id AND
    EXISTS (
      SELECT 1 FROM public.payments
      WHERE payments.user_id = auth.uid() AND payments.status = 'confirmed'
    )
  );

-- Fix 3: Explicit deny on user_roles for non-admin UPDATE (no update policy exists, but let's be safe)
-- Also ensure the existing INSERT policy is admin-only (it already is, but re-confirm target)
-- The key fix: there's no way for non-admins to insert/update roles since policies already require admin.
-- But we should NOT have any gaps. The table already blocks UPDATE for everyone.
-- We just need to ensure no regression. Already covered by existing admin-only INSERT policy.
