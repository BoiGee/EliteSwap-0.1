DELETE FROM public.payment_verification_attempts a
USING public.payment_verification_attempts b
WHERE a.reason = 'user_notified_underpaid'
  AND b.reason = 'user_notified_underpaid'
  AND a.payment_id = b.payment_id
  AND a.attempted_at > b.attempted_at;

CREATE UNIQUE INDEX IF NOT EXISTS payment_verification_attempts_one_underpaid_notify_per_payment
ON public.payment_verification_attempts (payment_id)
WHERE reason = 'user_notified_underpaid';