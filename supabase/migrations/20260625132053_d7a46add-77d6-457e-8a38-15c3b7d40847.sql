
-- Add new columns to backup_runs
ALTER TABLE public.backup_runs
  ADD COLUMN IF NOT EXISTS storage_file_count integer,
  ADD COLUMN IF NOT EXISTS storage_bytes bigint,
  ADD COLUMN IF NOT EXISTS auth_user_count integer;

-- SECURITY DEFINER RPC: export safe auth.users columns for backup.
-- Callable only by service_role (edge function uses service key).
CREATE OR REPLACE FUNCTION public.export_auth_users_for_backup()
RETURNS TABLE(
  id uuid,
  email text,
  phone text,
  created_at timestamptz,
  updated_at timestamptz,
  last_sign_in_at timestamptz,
  email_confirmed_at timestamptz,
  phone_confirmed_at timestamptz,
  banned_until timestamptz,
  raw_user_meta_data jsonb,
  raw_app_meta_data jsonb,
  is_sso_user boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT u.id, u.email, u.phone, u.created_at, u.updated_at,
         u.last_sign_in_at, u.email_confirmed_at, u.phone_confirmed_at,
         u.banned_until, u.raw_user_meta_data, u.raw_app_meta_data,
         u.is_sso_user
  FROM auth.users u
  ORDER BY u.created_at;
$$;

REVOKE ALL ON FUNCTION public.export_auth_users_for_backup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.export_auth_users_for_backup() TO service_role;
