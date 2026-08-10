
CREATE UNIQUE INDEX IF NOT EXISTS payment_verification_attempts_one_pool_exhausted_per_payment
  ON public.payment_verification_attempts (payment_id)
  WHERE reason = 'pool_exhausted_admin_notified';
