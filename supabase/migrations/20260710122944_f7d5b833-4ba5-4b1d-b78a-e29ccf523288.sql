
-- 1) Secrets table — decart_key stored separately from user-facing api_keys.key.
CREATE TABLE IF NOT EXISTS public.api_key_secrets (
  api_key_id UUID PRIMARY KEY REFERENCES public.api_keys(id) ON DELETE CASCADE,
  decart_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No grants to anon/authenticated — this is server-only. Only SECURITY DEFINER
-- functions and service_role may read/write.
GRANT ALL ON public.api_key_secrets TO service_role;

ALTER TABLE public.api_key_secrets ENABLE ROW LEVEL SECURITY;

-- Explicit deny by omission — no policies for authenticated/anon means no access.
CREATE POLICY "service role manages secrets"
  ON public.api_key_secrets
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 2) Backfill from existing api_keys.
INSERT INTO public.api_key_secrets (api_key_id, decart_key)
SELECT id, key FROM public.api_keys
ON CONFLICT (api_key_id) DO NOTHING;

-- 3) Trigger: whenever a new api_keys row is inserted, mirror its key into
-- api_key_secrets so future rotations of api_keys.key don't break Decart.
CREATE OR REPLACE FUNCTION public.mirror_api_key_secret()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.api_key_secrets(api_key_id, decart_key)
  VALUES (NEW.id, NEW.key)
  ON CONFLICT (api_key_id) DO UPDATE
    SET decart_key = EXCLUDED.decart_key,
        updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mirror_api_key_secret_ins ON public.api_keys;
CREATE TRIGGER trg_mirror_api_key_secret_ins
AFTER INSERT ON public.api_keys
FOR EACH ROW EXECUTE FUNCTION public.mirror_api_key_secret();

-- 4) mint_studio_credentials — the single chokepoint every studio launch flows
-- through. Combines the check_studio_session validation with the connect-attempt
-- log, and only then returns the Decart credential.
CREATE OR REPLACE FUNCTION public.mint_studio_credentials(p_key text)
RETURNS TABLE(
  ok boolean,
  reason text,
  decart_key text,
  remaining_ms bigint,
  label text,
  is_trial boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.api_keys%ROWTYPE;
  v_secret text;
  v_age_ms bigint;
  v_is_trial boolean;
  v_expired boolean;
  v_trial_exhausted boolean;
  v_foreign_exists boolean;
BEGIN
  IF v_uid IS NULL THEN
    RETURN QUERY SELECT false, 'not_authenticated'::text, NULL::text, NULL::bigint, NULL::text, false;
    RETURN;
  END IF;

  SELECT * INTO v_row
    FROM public.api_keys
   WHERE key = trim(p_key) AND user_id = v_uid
   ORDER BY is_active DESC, created_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    SELECT EXISTS(SELECT 1 FROM public.api_keys WHERE key = trim(p_key)) INTO v_foreign_exists;
    IF v_foreign_exists THEN
      RETURN QUERY SELECT false, 'not_owner'::text, NULL::text, NULL::bigint, NULL::text, false;
    ELSE
      RETURN QUERY SELECT false, 'key_not_found'::text, NULL::text, NULL::bigint, NULL::text, false;
    END IF;
    RETURN;
  END IF;

  v_is_trial := COALESCE(v_row.label, '') ILIKE 'free trial%'
             OR COALESCE(v_row.label, '') ILIKE 'trial%'
             OR v_row.pool_key_id IS NOT NULL;
  v_expired := v_row.expires_at IS NOT NULL AND v_row.expires_at <= now();
  v_trial_exhausted := v_is_trial AND v_row.remaining_ms IS NOT NULL AND v_row.remaining_ms <= 0;

  IF NOT v_row.is_active OR (v_is_trial AND v_expired) OR v_trial_exhausted THEN
    RETURN QUERY SELECT false, 'expired_or_inactive'::text, NULL::text, v_row.remaining_ms, v_row.label, v_is_trial;
    RETURN;
  END IF;

  IF v_is_trial AND v_row.remaining_ms IS NOT NULL AND v_row.remaining_ms < 30000 THEN
    RETURN QUERY SELECT false, 'trial_time_too_low'::text, NULL::text, v_row.remaining_ms, v_row.label, v_is_trial;
    RETURN;
  END IF;

  IF v_row.active_session_id IS NOT NULL AND v_row.active_session_started_at IS NOT NULL THEN
    v_age_ms := EXTRACT(EPOCH FROM (now() - v_row.active_session_started_at)) * 1000;
    IF v_age_ms < 90000 THEN
      RETURN QUERY SELECT false, 'already_active_elsewhere'::text, NULL::text, v_row.remaining_ms, v_row.label, v_is_trial;
      RETURN;
    END IF;
  END IF;

  -- Fetch the Decart credential from the private secrets table.
  SELECT s.decart_key INTO v_secret
    FROM public.api_key_secrets s
   WHERE s.api_key_id = v_row.id;

  IF v_secret IS NULL THEN
    -- Legacy row without a mirrored secret — fall back to key and heal.
    v_secret := v_row.key;
    INSERT INTO public.api_key_secrets(api_key_id, decart_key)
    VALUES (v_row.id, v_row.key)
    ON CONFLICT (api_key_id) DO NOTHING;
  END IF;

  -- Audit: record the connect attempt BEFORE returning the credential.
  BEGIN
    PERFORM public.record_studio_connect_attempt(v_row.key);
  EXCEPTION WHEN OTHERS THEN
    -- Never block the launch on activity logging.
    NULL;
  END;

  RETURN QUERY SELECT true, NULL::text, v_secret, v_row.remaining_ms, v_row.label, v_is_trial;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mint_studio_credentials(text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.mint_studio_credentials(text) FROM anon, public;
