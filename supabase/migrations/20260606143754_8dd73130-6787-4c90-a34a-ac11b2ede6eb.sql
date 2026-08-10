
ALTER TABLE public.pricing_plans
  ADD COLUMN IF NOT EXISTS key_duration_minutes INTEGER NULL,
  ADD COLUMN IF NOT EXISTS low_stock_threshold INTEGER NOT NULL DEFAULT 3;

UPDATE public.pricing_plans SET key_duration_minutes = 45  WHERE name = 'Basic'        AND key_duration_minutes IS NULL;
UPDATE public.pricing_plans SET key_duration_minutes = 90  WHERE name = 'Professional' AND key_duration_minutes IS NULL;
UPDATE public.pricing_plans SET key_duration_minutes = 420 WHERE name = 'Enterprise'   AND key_duration_minutes IS NULL;

ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS payment_id   UUID NULL,
  ADD COLUMN IF NOT EXISTS pool_key_id  UUID NULL;

CREATE UNIQUE INDEX IF NOT EXISTS api_keys_payment_id_unique
  ON public.api_keys(payment_id) WHERE payment_id IS NOT NULL;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS pending_key_assignment BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.api_key_pool (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key               TEXT NOT NULL UNIQUE,
  plan_id               UUID NULL,
  status                TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','assigned','disabled')),
  assigned_to_user_id   UUID NULL,
  assigned_payment_id   UUID NULL,
  assigned_at           TIMESTAMPTZ NULL,
  note                  TEXT NULL,
  created_by            UUID NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_key_pool_status_plan_idx
  ON public.api_key_pool(status, plan_id, created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.api_key_pool TO authenticated;
GRANT ALL ON public.api_key_pool TO service_role;

ALTER TABLE public.api_key_pool ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins manage api_key_pool" ON public.api_key_pool;
CREATE POLICY "Admins manage api_key_pool" ON public.api_key_pool
  FOR ALL TO authenticated
  USING (public.has_role('admin'::app_role))
  WITH CHECK (public.has_role('admin'::app_role));

CREATE OR REPLACE FUNCTION public.touch_api_key_pool_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_api_key_pool_updated_at ON public.api_key_pool;
CREATE TRIGGER trg_api_key_pool_updated_at
  BEFORE UPDATE ON public.api_key_pool
  FOR EACH ROW EXECUTE FUNCTION public.touch_api_key_pool_updated_at();

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
BEGIN
  SELECT * INTO v_payment FROM public.payments WHERE id = p_payment_id;
  IF NOT FOUND OR v_payment.status <> 'confirmed' THEN
    RETURN NULL;
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

REVOKE ALL ON FUNCTION public.issue_api_key_for_payment(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.issue_api_key_for_payment(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.payments_auto_issue_key()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'confirmed'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'confirmed') THEN
    PERFORM public.issue_api_key_for_payment(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payments_auto_issue_key ON public.payments;
CREATE TRIGGER trg_payments_auto_issue_key
  AFTER INSERT OR UPDATE OF status ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.payments_auto_issue_key();
