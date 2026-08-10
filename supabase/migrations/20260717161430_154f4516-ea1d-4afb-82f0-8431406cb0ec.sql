
-- 1. Drop redundant narrower duplicate index (fully covered by the >=32 variant)
DROP INDEX IF EXISTS public.payments_tx_hash_confirmed_unique;

-- 2. Duplicate-aware admin_set_payment_status
CREATE OR REPLACE FUNCTION public.admin_set_payment_status(
  p_payment_id uuid,
  p_status text,
  p_plan_id uuid DEFAULT NULL::uuid,
  p_amount_usd numeric DEFAULT NULL::numeric
)
RETURNS payments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_payment      public.payments%ROWTYPE;
  v_target       public.payments%ROWTYPE;
  v_conflict     public.payments%ROWTYPE;
  v_conflict_email text;
BEGIN
  IF NOT (public.has_role(auth.uid(), 'admin'::app_role)
       OR public.has_role(auth.uid(), 'sec_admin'::app_role)) THEN
    RAISE EXCEPTION 'Not authorized to manage payments' USING ERRCODE = '42501';
  END IF;

  IF p_status NOT IN ('confirmed', 'rejected') THEN
    RAISE EXCEPTION 'Invalid payment status' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_target FROM public.payments WHERE id = p_payment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found' USING ERRCODE = 'P0002';
  END IF;

  -- Duplicate-tx_hash guard: only when approving a crypto payment with a hash.
  IF p_status = 'confirmed'
     AND COALESCE(v_target.payment_method, '') = 'crypto'
     AND v_target.tx_hash IS NOT NULL
     AND length(v_target.tx_hash) >= 32 THEN

    SELECT * INTO v_conflict
    FROM public.payments
    WHERE id <> p_payment_id
      AND status = 'confirmed'
      AND payment_method = 'crypto'
      AND tx_hash IS NOT NULL
      AND lower(tx_hash) = lower(v_target.tx_hash)
    LIMIT 1;

    IF FOUND THEN
      -- Same user + already confirmed → idempotent no-op.
      IF v_conflict.user_id = v_target.user_id THEN
        -- If the target row itself is still pending, leave it alone and
        -- return the already-confirmed row so the UI treats it as done.
        RETURN v_conflict;
      END IF;

      SELECT email INTO v_conflict_email
      FROM auth.users WHERE id = v_conflict.user_id;

      RAISE EXCEPTION
        'This transaction hash is already credited to payment % (user %). Reject this duplicate instead of approving.',
        v_conflict.id, COALESCE(v_conflict_email, v_conflict.user_id::text)
        USING ERRCODE = '23505';
    END IF;
  END IF;

  BEGIN
    UPDATE public.payments
    SET status = p_status,
        plan_id = CASE WHEN p_status = 'confirmed' AND p_plan_id IS NOT NULL THEN p_plan_id ELSE plan_id END,
        amount_usd = CASE WHEN p_status = 'confirmed' AND p_amount_usd IS NOT NULL THEN p_amount_usd ELSE amount_usd END,
        updated_at = now()
    WHERE id = p_payment_id
    RETURNING * INTO v_payment;
  EXCEPTION WHEN unique_violation THEN
    -- Safety net in case of a race between the pre-check and the UPDATE.
    SELECT * INTO v_conflict
    FROM public.payments
    WHERE id <> p_payment_id
      AND status = 'confirmed'
      AND payment_method = 'crypto'
      AND tx_hash IS NOT NULL
      AND lower(tx_hash) = lower(v_target.tx_hash)
    LIMIT 1;

    IF FOUND AND v_conflict.user_id = v_target.user_id THEN
      RETURN v_conflict;
    END IF;

    SELECT email INTO v_conflict_email
    FROM auth.users WHERE id = COALESCE(v_conflict.user_id, v_target.user_id);

    RAISE EXCEPTION
      'This transaction hash is already credited to another confirmed payment (user %). Reject this duplicate instead of approving.',
      COALESCE(v_conflict_email, 'unknown')
      USING ERRCODE = '23505';
  END;

  RETURN v_payment;
END;
$function$;
