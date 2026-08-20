-- Paystack is being removed from the $10 trial pipeline in favor of a
-- manual Mobile Money transfer + pasted-reference flow (mirrors the
-- existing USDT off-chain/Binance-internal manual-review path). Widen the
-- payment_method check to allow the new value while keeping 'paystack'
-- valid so historical rows (real Paystack purchases made before this
-- change) still satisfy the constraint.
ALTER TABLE public.trial_purchases
  DROP CONSTRAINT IF EXISTS trial_purchases_payment_method_check;

ALTER TABLE public.trial_purchases
  ADD CONSTRAINT trial_purchases_payment_method_check
  CHECK (payment_method IN ('usdt', 'paystack', 'momo_manual'));
