
-- Realign verifier RPCs with the actual payment status used at insert time.

CREATE OR REPLACE FUNCTION public.payments_pending_verification()
RETURNS TABLE(id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT id FROM public.payments
  WHERE status = 'pending'
    AND payment_method = 'crypto'
    AND tx_hash IS NOT NULL
    AND length(tx_hash) >= 32
    AND created_at > now() - interval '24 hours'
  ORDER BY created_at ASC
  LIMIT 50;
$$;

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
    AND status = 'pending'
  RETURNING * INTO v_payment;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not in pending state (already actioned or missing)'
      USING ERRCODE = 'P0002';
  END IF;

  RETURN v_payment;
END;
$$;
