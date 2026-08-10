CREATE OR REPLACE FUNCTION public.issue_api_key_for_payment(p_payment_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment    public.payments%ROWTYPE;
  v_minutes    INTEGER;
  v_plan_name  TEXT;
  v_pool_row   public.api_key_pool%ROWTYPE;
  v_new_key_id UUID;
  v_caller     UUID := auth.uid();
  v_role       TEXT := auth.role();
BEGIN
  SELECT * INTO v_payment FROM public.payments WHERE id = p_payment_id;
  IF NOT FOUND OR v_payment.status <> 'confirmed' THEN
    RETURN NULL;
  END IF;

  IF v_role <> 'service_role'
     AND (v_caller IS NULL
          OR (v_caller <> v_payment.user_id
              AND NOT public.has_role(v_caller, 'admin'::public.app_role))) THEN
    RAISE EXCEPTION 'not authorized to issue key for this payment';
  END IF;

  IF EXISTS (SELECT 1 FROM public.api_keys WHERE payment_id = p_payment_id) THEN
    UPDATE public.payments SET pending_key_assignment = false WHERE id = p_payment_id;
    RETURN NULL;
  END IF;

  IF v_payment.plan_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT key_duration_minutes, name
    INTO v_minutes, v_plan_name
    FROM public.pricing_plans
    WHERE id = v_payment.plan_id;

  IF v_minutes IS NULL OR v_minutes <= 0 THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_pool_row
    FROM public.api_key_pool
    WHERE status = 'available' AND plan_id = v_payment.plan_id
    ORDER BY created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1;

  IF NOT FOUND THEN
    SELECT * INTO v_pool_row
      FROM public.api_key_pool
      WHERE status = 'available' AND plan_id IS NULL
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1;
  END IF;

  IF NOT FOUND THEN
    UPDATE public.payments SET pending_key_assignment = true WHERE id = p_payment_id;
    RETURN NULL;
  END IF;

  -- Race-safe issuance: if another concurrent confirmation already inserted an
  -- api_keys row for this payment, release the locked pool key and exit cleanly
  -- instead of bubbling a unique_violation up to the caller (which would abort
  -- the whole status='confirmed' UPDATE).
  BEGIN
    UPDATE public.api_key_pool
      SET status = 'assigned',
          assigned_to_user_id = v_payment.user_id,
          assigned_payment_id = v_payment.id,
          assigned_at = now()
      WHERE id = v_pool_row.id;

    INSERT INTO public.api_keys (user_id, key, label, is_active, remaining_ms, payment_id, pool_key_id)
    VALUES (
      v_payment.user_id,
      v_pool_row.api_key,
      v_plan_name,
      true,
      (v_minutes::BIGINT) * 60000,
      v_payment.id,
      v_pool_row.id
    )
    RETURNING id INTO v_new_key_id;
  EXCEPTION WHEN unique_violation THEN
    -- Another tx beat us to it. Roll the pool key back to available and noop.
    UPDATE public.api_key_pool
      SET status = 'available',
          assigned_to_user_id = NULL,
          assigned_payment_id = NULL,
          assigned_at = NULL
      WHERE id = v_pool_row.id;
    UPDATE public.payments SET pending_key_assignment = false WHERE id = p_payment_id;
    RETURN NULL;
  END;

  UPDATE public.payments SET pending_key_assignment = false WHERE id = p_payment_id;

  RETURN v_new_key_id;
END;
$$;