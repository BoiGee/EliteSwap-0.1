
-- Add Paystack-related columns to payments
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS payment_method text NOT NULL DEFAULT 'crypto',
  ADD COLUMN IF NOT EXISTS paystack_reference text,
  ADD COLUMN IF NOT EXISTS plan_id uuid REFERENCES public.pricing_plans(id) ON DELETE SET NULL;

-- Unique constraint on paystack_reference (allows multiple NULLs)
CREATE UNIQUE INDEX IF NOT EXISTS payments_paystack_reference_key
  ON public.payments(paystack_reference)
  WHERE paystack_reference IS NOT NULL;

-- Make currency nullable for Paystack rows
ALTER TABLE public.payments ALTER COLUMN currency DROP NOT NULL;

-- Replace the user INSERT policy to allow both crypto and paystack pending payments
DROP POLICY IF EXISTS "Users can insert own payments" ON public.payments;

CREATE POLICY "Users can insert own payments"
ON public.payments
FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = user_id
  AND status = 'pending'
  AND payment_method IN ('crypto', 'paystack')
);
