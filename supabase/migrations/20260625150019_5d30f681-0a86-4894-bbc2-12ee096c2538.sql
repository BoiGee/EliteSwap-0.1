
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS assigned_at timestamptz;

UPDATE public.api_keys SET assigned_at = COALESCE(assigned_at, created_at) WHERE user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.tg_api_keys_stamp_assigned_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.user_id IS NOT NULL AND NEW.assigned_at IS NULL THEN
      NEW.assigned_at := now();
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.user_id IS NOT NULL
       AND (OLD.user_id IS DISTINCT FROM NEW.user_id)
       AND NEW.assigned_at IS NOT DISTINCT FROM OLD.assigned_at THEN
      NEW.assigned_at := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_api_keys_stamp_assigned_at ON public.api_keys;
CREATE TRIGGER tg_api_keys_stamp_assigned_at
BEFORE INSERT OR UPDATE OF user_id ON public.api_keys
FOR EACH ROW EXECUTE FUNCTION public.tg_api_keys_stamp_assigned_at();
