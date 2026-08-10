
-- 1) duration on pool keys (default 4 minutes)
ALTER TABLE public.free_trial_keys
  ALTER COLUMN trial_duration_ms SET DEFAULT 240000;
UPDATE public.free_trial_keys
  SET trial_duration_ms = 240000
  WHERE trial_duration_ms IS NULL OR trial_duration_ms < 60000;

-- 2) allow up to 2 trial assignments per user
ALTER TABLE public.free_trial_assignments
  DROP CONSTRAINT IF EXISTS free_trial_assignments_session_number_check;
ALTER TABLE public.free_trial_assignments
  ADD CONSTRAINT free_trial_assignments_session_number_check
  CHECK (session_number BETWEEN 1 AND 2) NOT VALID;

-- 3) trial_purchases table
CREATE TABLE public.trial_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  payment_method text NOT NULL CHECK (payment_method IN ('usdt','paystack')),
  amount_usd numeric NOT NULL DEFAULT 10,
  amount_local numeric,
  currency text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','confirmed','failed','expired')),
  provider_reference text,
  paystack_authorization_url text,
  usdt_network text,
  usdt_address text,
  assigned_key_id uuid REFERENCES public.free_trial_keys(id) ON DELETE SET NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.trial_purchases TO authenticated;
GRANT ALL ON public.trial_purchases TO service_role;

ALTER TABLE public.trial_purchases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own trial purchases"
  ON public.trial_purchases FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id OR public.has_role('admin'::app_role));

CREATE POLICY "Admins manage trial purchases"
  ON public.trial_purchases FOR ALL
  TO authenticated
  USING (public.has_role('admin'::app_role))
  WITH CHECK (public.has_role('admin'::app_role));

CREATE UNIQUE INDEX trial_purchases_provider_reference_uq
  ON public.trial_purchases (provider_reference)
  WHERE provider_reference IS NOT NULL;
CREATE INDEX trial_purchases_user_idx ON public.trial_purchases (user_id, created_at DESC);

CREATE TRIGGER trial_purchases_set_updated
  BEFORE UPDATE ON public.trial_purchases
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 4) assign trial key after payment confirmed
CREATE OR REPLACE FUNCTION public.assign_trial_key_from_purchase(p_purchase_id uuid)
RETURNS TABLE(api_key_id uuid, api_key text, expires_at timestamptz, duration_ms bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_purchase public.trial_purchases%ROWTYPE;
  v_pool_key public.free_trial_keys%ROWTYPE;
  v_new_api_key public.api_keys%ROWTYPE;
  v_used_count int;
  v_next_session int;
  v_duration bigint;
BEGIN
  SELECT * INTO v_purchase FROM public.trial_purchases WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_purchase.status <> 'confirmed' THEN
    RAISE EXCEPTION 'Purchase not confirmed' USING ERRCODE = '42501';
  END IF;
  IF v_purchase.assigned_key_id IS NOT NULL THEN
    -- idempotent: return existing assignment
    SELECT * INTO v_new_api_key FROM public.api_keys
      WHERE user_id = v_purchase.user_id
      AND pool_key_id = v_purchase.assigned_key_id
      LIMIT 1;
    IF FOUND THEN
      api_key_id := v_new_api_key.id;
      api_key := v_new_api_key.key;
      expires_at := v_new_api_key.expires_at;
      duration_ms := v_new_api_key.remaining_ms;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  -- enforce lifetime cap of 2 confirmed trial purchases per user
  SELECT count(*) INTO v_used_count
    FROM public.trial_purchases
    WHERE user_id = v_purchase.user_id
      AND status = 'confirmed'
      AND assigned_key_id IS NOT NULL;
  IF v_used_count >= 2 THEN
    RAISE EXCEPTION 'Trial limit reached' USING ERRCODE = '42501';
  END IF;

  -- pop oldest unclaimed key
  SELECT * INTO v_pool_key FROM public.free_trial_keys
    WHERE claimed_by_user_id IS NULL
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No trial keys available' USING ERRCODE = 'P0002';
  END IF;

  v_duration := COALESCE(v_pool_key.trial_duration_ms, 240000);

  UPDATE public.free_trial_keys
    SET claimed_by_user_id = v_purchase.user_id,
        claimed_at = now()
    WHERE id = v_pool_key.id;

  INSERT INTO public.api_keys (user_id, key, label, is_active, remaining_ms, expires_at, pool_key_id)
    VALUES (
      v_purchase.user_id,
      v_pool_key.api_key,
      'Trial Key',
      true,
      v_duration,
      now() + (v_duration || ' milliseconds')::interval,
      v_pool_key.id
    )
    RETURNING * INTO v_new_api_key;

  SELECT COALESCE(MAX(session_number), 0) + 1 INTO v_next_session
    FROM public.free_trial_assignments WHERE user_id = v_purchase.user_id;
  IF v_next_session > 2 THEN v_next_session := 2; END IF;

  INSERT INTO public.free_trial_assignments (user_id, free_trial_key_id, api_key_record_id, session_number)
    VALUES (v_purchase.user_id, v_pool_key.id, v_new_api_key.id, v_next_session)
    ON CONFLICT (user_id, session_number) DO NOTHING;

  UPDATE public.trial_purchases
    SET assigned_key_id = v_pool_key.id,
        updated_at = now()
    WHERE id = p_purchase_id;

  api_key_id := v_new_api_key.id;
  api_key := v_new_api_key.key;
  expires_at := v_new_api_key.expires_at;
  duration_ms := v_duration;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_trial_key_from_purchase(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_trial_key_from_purchase(uuid) TO service_role;

-- 5) helper for client to see how many trials remain
CREATE OR REPLACE FUNCTION public.trial_purchases_remaining(p_user_id uuid)
RETURNS int
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT GREATEST(0, 2 - COALESCE(
    (SELECT count(*)::int FROM public.trial_purchases
      WHERE user_id = p_user_id
        AND status = 'confirmed'
        AND assigned_key_id IS NOT NULL), 0));
$$;
GRANT EXECUTE ON FUNCTION public.trial_purchases_remaining(uuid) TO authenticated, service_role;

-- 6) revoke old public free-claim function
REVOKE EXECUTE ON FUNCTION public.claim_free_trial_key(text, text) FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_free_trial_key() FROM public, anon, authenticated;
