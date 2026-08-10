
ALTER TABLE public.api_keys ADD COLUMN expires_at timestamp with time zone DEFAULT NULL;

-- Create a function to auto-deactivate expired keys
CREATE OR REPLACE FUNCTION public.deactivate_expired_api_keys()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.api_keys
  SET is_active = false
  WHERE is_active = true
    AND expires_at IS NOT NULL
    AND expires_at <= now();
END;
$$;
