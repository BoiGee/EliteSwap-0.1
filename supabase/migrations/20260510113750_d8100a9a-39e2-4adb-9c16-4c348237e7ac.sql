CREATE OR REPLACE FUNCTION public.admin_set_payment_status(
  p_payment_id uuid,
  p_status text,
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
  IF NOT public.has_role('admin'::app_role) THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;

  IF p_status NOT IN ('confirmed', 'rejected') THEN
    RAISE EXCEPTION 'Invalid payment status' USING ERRCODE = '22023';
  END IF;

  UPDATE public.payments
  SET status = p_status,
      plan_id = CASE WHEN p_status = 'confirmed' AND p_plan_id IS NOT NULL THEN p_plan_id ELSE plan_id END,
      amount_usd = CASE WHEN p_status = 'confirmed' AND p_amount_usd IS NOT NULL THEN p_amount_usd ELSE amount_usd END,
      updated_at = now()
  WHERE id = p_payment_id
  RETURNING * INTO v_payment;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found' USING ERRCODE = 'P0002';
  END IF;

  RETURN v_payment;
END;
$$;