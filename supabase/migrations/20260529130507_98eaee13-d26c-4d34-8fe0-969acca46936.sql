CREATE TABLE public.payment_verification_attempts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  payment_id uuid NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL,
  reason text,
  confirmations integer,
  on_chain_amount numeric,
  expected_amount_usd numeric,
  raw jsonb
);

GRANT SELECT ON public.payment_verification_attempts TO authenticated;
GRANT ALL ON public.payment_verification_attempts TO service_role;

ALTER TABLE public.payment_verification_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view verification attempts"
  ON public.payment_verification_attempts
  FOR SELECT
  TO authenticated
  USING (public.has_role('admin'::app_role));

CREATE INDEX idx_pva_payment_id_attempted_at
  ON public.payment_verification_attempts(payment_id, attempted_at DESC);

-- Scoped only to crypto payments with realistic hash lengths so legacy
-- placeholder values (e.g. "momo") remain unaffected.
CREATE UNIQUE INDEX payments_unique_confirmed_tx_hash
  ON public.payments (lower(tx_hash))
  WHERE status = 'confirmed'
    AND payment_method = 'crypto'
    AND tx_hash IS NOT NULL
    AND length(tx_hash) >= 32;

CREATE OR REPLACE FUNCTION public.auto_confirm_payment_from_verifier(
  p_payment_id uuid,
  p_plan_id uuid DEFAULT NULL,
  p_amount_usd numeric DEFAULT NULL
)
RETURNS public.payments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_payment public.payments%ROWTYPE;
BEGIN
  UPDATE public.payments
  SET status = 'confirmed',
      plan_id = COALESCE(p_plan_id, plan_id),
      amount_usd = COALESCE(p_amount_usd, amount_usd),
      updated_at = now()
  WHERE id = p_payment_id
    AND status = 'pending_review'
  RETURNING * INTO v_payment;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not in pending_review (already actioned or missing)'
      USING ERRCODE = 'P0002';
  END IF;

  RETURN v_payment;
END;
$$;

REVOKE ALL ON FUNCTION public.auto_confirm_payment_from_verifier(uuid, uuid, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auto_confirm_payment_from_verifier(uuid, uuid, numeric) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.auto_confirm_payment_from_verifier(uuid, uuid, numeric) TO service_role;

CREATE OR REPLACE FUNCTION public.payments_pending_verification()
RETURNS TABLE(id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT id FROM public.payments
  WHERE status = 'pending_review'
    AND payment_method = 'crypto'
    AND tx_hash IS NOT NULL
    AND length(tx_hash) >= 32
    AND created_at > now() - interval '24 hours'
  ORDER BY created_at ASC
  LIMIT 50;
$$;

REVOKE ALL ON FUNCTION public.payments_pending_verification() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payments_pending_verification() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.payments_pending_verification() TO service_role;

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;