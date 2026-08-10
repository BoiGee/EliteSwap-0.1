DROP POLICY IF EXISTS "Users can insert own payments" ON public.payments;

CREATE POLICY "Users can insert own payments"
ON public.payments
FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = user_id
  AND status IN ('pending', 'pending_review')
  AND payment_method = 'crypto'
  AND commission_pct_snapshot IS NULL
  AND commission_base_usd_snapshot IS NULL
  AND discount_amount_usd IS NULL
);