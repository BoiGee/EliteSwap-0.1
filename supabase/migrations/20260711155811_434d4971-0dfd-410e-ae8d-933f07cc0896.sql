DROP POLICY IF EXISTS "Users can insert own payments" ON public.payments;

CREATE POLICY "Users can insert own payments"
ON public.payments
FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = user_id
  AND status = ANY (ARRAY['pending'::text, 'pending_review'::text])
  AND payment_method = 'crypto'::text
  AND commission_pct_snapshot IS NULL
);