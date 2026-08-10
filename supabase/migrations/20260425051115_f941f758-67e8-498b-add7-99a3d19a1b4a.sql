
ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS active_session_id text,
  ADD COLUMN IF NOT EXISTS active_session_started_at timestamptz;

CREATE INDEX IF NOT EXISTS api_keys_active_session_idx
  ON public.api_keys (active_session_started_at)
  WHERE active_session_id IS NOT NULL;

-- Defence in depth: block updates of timer/session fields by anyone other
-- than the key's owner or the service role.
CREATE OR REPLACE FUNCTION public.tg_api_keys_guard_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text := auth.role();
BEGIN
  -- Service role and admin tooling bypass.
  IF v_role = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Only enforce on changes to the protected columns.
  IF NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.remaining_ms IS DISTINCT FROM OLD.remaining_ms
     OR NEW.active_session_id IS DISTINCT FROM OLD.active_session_id
     OR NEW.active_session_started_at IS DISTINCT FROM OLD.active_session_started_at
     OR NEW.is_active IS DISTINCT FROM OLD.is_active
  THEN
    IF v_uid IS NULL OR v_uid <> OLD.user_id THEN
      -- Allow if the caller is an admin (admins manage keys via UI).
      IF NOT public.has_role('admin'::app_role) THEN
        RAISE EXCEPTION 'Not allowed: api_keys timer/session fields can only be updated by the key owner'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS api_keys_guard_owner ON public.api_keys;
CREATE TRIGGER api_keys_guard_owner
BEFORE UPDATE ON public.api_keys
FOR EACH ROW
EXECUTE FUNCTION public.tg_api_keys_guard_owner();
