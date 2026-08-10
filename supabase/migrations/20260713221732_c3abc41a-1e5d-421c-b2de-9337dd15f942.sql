CREATE OR REPLACE FUNCTION public.server_now_ms()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (EXTRACT(EPOCH FROM now()) * 1000)::bigint;
$$;

GRANT EXECUTE ON FUNCTION public.server_now_ms() TO authenticated, service_role;