
-- 1. Lock down issue_api_key_for_payment
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

  -- Authorization: only the payment owner, an admin, or a service-role process may trigger issuance
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

  UPDATE public.payments SET pending_key_assignment = false WHERE id = p_payment_id;

  RETURN v_new_key_id;
END;
$$;

-- 2. Tighten api_keys user UPDATE policy to also lock payment_id and pool_key_id
DROP POLICY IF EXISTS "Users can update own api_keys" ON public.api_keys;
CREATE POLICY "Users can update own api_keys"
ON public.api_keys
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (
  auth.uid() = user_id
  AND EXISTS (
    SELECT 1 FROM public.api_keys existing
    WHERE existing.id = api_keys.id
      AND existing.user_id = api_keys.user_id
      AND existing.key = api_keys.key
      AND NOT (existing.is_active IS DISTINCT FROM api_keys.is_active)
      AND NOT (existing.remaining_ms IS DISTINCT FROM api_keys.remaining_ms)
      AND NOT (existing.expires_at IS DISTINCT FROM api_keys.expires_at)
      AND NOT (existing.active_session_id IS DISTINCT FROM api_keys.active_session_id)
      AND NOT (existing.active_session_started_at IS DISTINCT FROM api_keys.active_session_started_at)
      AND NOT (existing.last_session_ended_at IS DISTINCT FROM api_keys.last_session_ended_at)
      AND NOT (existing.created_at IS DISTINCT FROM api_keys.created_at)
      AND NOT (existing.payment_id IS DISTINCT FROM api_keys.payment_id)
      AND NOT (existing.pool_key_id IS DISTINCT FROM api_keys.pool_key_id)
  )
);

-- 3. Remove user self-insert on api_keys (issuance is server-side; admins still have their own policy)
DROP POLICY IF EXISTS "Users can insert own api_keys" ON public.api_keys;

-- 4. Remove system_announcements from the realtime publication
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'system_announcements'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime DROP TABLE public.system_announcements';
  END IF;
END $$;
