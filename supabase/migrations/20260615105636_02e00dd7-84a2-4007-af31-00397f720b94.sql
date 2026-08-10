
CREATE OR REPLACE FUNCTION public.list_public_tables_for_backup()
RETURNS TABLE(table_name TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.relname::TEXT AS table_name
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname NOT LIKE 'pg_%'
  ORDER BY c.relname;
$$;

REVOKE EXECUTE ON FUNCTION public.list_public_tables_for_backup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_public_tables_for_backup() TO service_role;
