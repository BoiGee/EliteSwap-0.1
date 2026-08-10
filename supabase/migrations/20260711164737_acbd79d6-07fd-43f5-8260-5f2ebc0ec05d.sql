
-- Add two nullable columns to backup_runs for extended coverage tracking
ALTER TABLE public.backup_runs
  ADD COLUMN IF NOT EXISTS schema_ddl_bytes integer,
  ADD COLUMN IF NOT EXISTS extras_ok jsonb;

-- 1) Schema DDL export (tables, columns, constraints, indexes, views, sequences, enums, RLS policies, triggers, functions)
CREATE OR REPLACE FUNCTION public.export_schema_ddl_for_backup()
RETURNS text
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  ddl text := '';
  r record;
  col_defs text;
  con_defs text;
BEGIN
  ddl := ddl || E'-- Eliteswap schema DDL export\n-- Generated: ' || now()::text || E'\n\n';

  -- Enums
  ddl := ddl || E'\n-- ==== ENUM TYPES ====\n';
  FOR r IN
    SELECT n.nspname, t.typname,
           string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder) AS labels
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE n.nspname = 'public'
    GROUP BY n.nspname, t.typname
  LOOP
    ddl := ddl || format(E'CREATE TYPE %I.%I AS ENUM (%s);\n', r.nspname, r.typname, r.labels);
  END LOOP;

  -- Sequences
  ddl := ddl || E'\n-- ==== SEQUENCES ====\n';
  FOR r IN
    SELECT sequence_schema, sequence_name
    FROM information_schema.sequences
    WHERE sequence_schema = 'public'
    ORDER BY sequence_name
  LOOP
    ddl := ddl || format(E'CREATE SEQUENCE IF NOT EXISTS %I.%I;\n', r.sequence_schema, r.sequence_name);
  END LOOP;

  -- Tables
  ddl := ddl || E'\n-- ==== TABLES ====\n';
  FOR r IN
    SELECT c.oid, c.relname, n.nspname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  LOOP
    -- columns
    SELECT string_agg(
      format('  %I %s%s%s',
        a.attname,
        pg_catalog.format_type(a.atttypid, a.atttypmod),
        CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END,
        CASE WHEN ad.adbin IS NOT NULL
             THEN ' DEFAULT ' || pg_get_expr(ad.adbin, ad.adrelid)
             ELSE '' END
      ),
      E',\n' ORDER BY a.attnum)
    INTO col_defs
    FROM pg_attribute a
    LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    WHERE a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped;

    -- table-level constraints (pk, unique, check, fk)
    SELECT string_agg(
      format('  CONSTRAINT %I %s', con.conname, pg_get_constraintdef(con.oid)),
      E',\n')
    INTO con_defs
    FROM pg_constraint con
    WHERE con.conrelid = r.oid;

    ddl := ddl || format(E'CREATE TABLE IF NOT EXISTS %I.%I (\n%s%s\n);\n\n',
      r.nspname, r.relname,
      col_defs,
      CASE WHEN con_defs IS NOT NULL THEN E',\n' || con_defs ELSE '' END);
  END LOOP;

  -- Indexes (skip those auto-created by constraints)
  ddl := ddl || E'\n-- ==== INDEXES ====\n';
  FOR r IN
    SELECT indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname NOT IN (
        SELECT conname FROM pg_constraint WHERE contype IN ('p','u')
      )
    ORDER BY tablename, indexname
  LOOP
    ddl := ddl || r.indexdef || E';\n';
  END LOOP;

  -- Views
  ddl := ddl || E'\n-- ==== VIEWS ====\n';
  FOR r IN
    SELECT table_schema, table_name, view_definition
    FROM information_schema.views
    WHERE table_schema = 'public'
    ORDER BY table_name
  LOOP
    ddl := ddl || format(E'CREATE OR REPLACE VIEW %I.%I AS\n%s\n\n',
      r.table_schema, r.table_name, r.view_definition);
  END LOOP;

  -- Functions
  ddl := ddl || E'\n-- ==== FUNCTIONS ====\n';
  FOR r IN
    SELECT p.oid
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind IN ('f','p')
    ORDER BY p.proname
  LOOP
    ddl := ddl || pg_get_functiondef(r.oid) || E';\n\n';
  END LOOP;

  -- Triggers
  ddl := ddl || E'\n-- ==== TRIGGERS ====\n';
  FOR r IN
    SELECT tgname, tgrelid
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
    ORDER BY tgname
  LOOP
    ddl := ddl || pg_get_triggerdef((SELECT oid FROM pg_trigger WHERE tgname = r.tgname AND tgrelid = r.tgrelid LIMIT 1)) || E';\n';
  END LOOP;

  -- RLS + Policies
  ddl := ddl || E'\n-- ==== ROW LEVEL SECURITY ====\n';
  FOR r IN
    SELECT n.nspname, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
    ORDER BY c.relname
  LOOP
    ddl := ddl || format(E'ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY;\n', r.nspname, r.relname);
  END LOOP;

  ddl := ddl || E'\n-- ==== POLICIES ====\n';
  FOR r IN
    SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
    ORDER BY tablename, policyname
  LOOP
    ddl := ddl || format(
      E'CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s%s%s;\n',
      r.policyname, r.schemaname, r.tablename,
      r.permissive,
      r.cmd,
      array_to_string(r.roles, ', '),
      CASE WHEN r.qual IS NOT NULL THEN ' USING (' || r.qual || ')' ELSE '' END,
      CASE WHEN r.with_check IS NOT NULL THEN ' WITH CHECK (' || r.with_check || ')' ELSE '' END
    );
  END LOOP;

  RETURN ddl;
END;
$$;

-- 2) Auth extras (identities, mfa_factors, session summaries) — no tokens
CREATE OR REPLACE FUNCTION public.export_auth_identities_for_backup()
RETURNS TABLE(id uuid, user_id uuid, provider text, provider_id text, email text, created_at timestamptz, updated_at timestamptz, last_sign_in_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth
AS $$
  SELECT i.id, i.user_id, i.provider, i.provider_id,
         (i.identity_data->>'email')::text,
         i.created_at, i.updated_at, i.last_sign_in_at
  FROM auth.identities i
  ORDER BY i.created_at;
$$;

CREATE OR REPLACE FUNCTION public.export_auth_mfa_factors_for_backup()
RETURNS TABLE(id uuid, user_id uuid, friendly_name text, factor_type text, status text, created_at timestamptz, updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth
AS $$
  SELECT f.id, f.user_id, f.friendly_name,
         f.factor_type::text, f.status::text,
         f.created_at, f.updated_at
  FROM auth.mfa_factors f
  ORDER BY f.created_at;
$$;

CREATE OR REPLACE FUNCTION public.export_auth_sessions_for_backup()
RETURNS TABLE(id uuid, user_id uuid, created_at timestamptz, updated_at timestamptz, ip inet, user_agent text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth
AS $$
  SELECT s.id, s.user_id, s.created_at, s.updated_at, s.ip, s.user_agent
  FROM auth.sessions s
  ORDER BY s.created_at DESC
  LIMIT 5000;
$$;

-- 3) Cron jobs
CREATE OR REPLACE FUNCTION public.export_cron_jobs_for_backup()
RETURNS TABLE(jobid bigint, jobname text, schedule text, command text, active boolean, database text, username text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, cron
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RETURN;
  END IF;
  RETURN QUERY EXECUTE
    'SELECT jobid, jobname, schedule, command, active, database, username FROM cron.job ORDER BY jobid';
END;
$$;

CREATE OR REPLACE FUNCTION public.export_cron_recent_runs_for_backup()
RETURNS TABLE(jobid bigint, runid bigint, job_pid integer, database text, username text, command text, status text, return_message text, start_time timestamptz, end_time timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, cron
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RETURN;
  END IF;
  RETURN QUERY EXECUTE
    'SELECT jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time
     FROM cron.job_run_details ORDER BY start_time DESC LIMIT 100';
END;
$$;

-- 4) Realtime publication membership
CREATE OR REPLACE FUNCTION public.export_realtime_publication_for_backup()
RETURNS TABLE(schemaname text, tablename text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
  SELECT schemaname::text, tablename::text
  FROM pg_publication_tables
  WHERE pubname = 'supabase_realtime'
  ORDER BY schemaname, tablename;
$$;

-- 5) Storage bucket metadata
CREATE OR REPLACE FUNCTION public.export_storage_buckets_for_backup()
RETURNS TABLE(id text, name text, public boolean, file_size_limit bigint, allowed_mime_types text[], created_at timestamptz, updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, storage
AS $$
  SELECT b.id, b.name, b.public, b.file_size_limit, b.allowed_mime_types, b.created_at, b.updated_at
  FROM storage.buckets b
  ORDER BY b.id;
$$;

-- 6) pgmq queues (best-effort)
CREATE OR REPLACE FUNCTION public.export_pgmq_queues_for_backup()
RETURNS TABLE(queue_name text, is_partitioned boolean, is_unlogged boolean, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pgmq
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgmq') THEN
    RETURN;
  END IF;
  RETURN QUERY EXECUTE
    'SELECT queue_name::text, is_partitioned, is_unlogged, created_at FROM pgmq.list_queues()';
END;
$$;

-- Grants — service role only (called from edge function)
REVOKE ALL ON FUNCTION public.export_schema_ddl_for_backup() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.export_auth_identities_for_backup() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.export_auth_mfa_factors_for_backup() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.export_auth_sessions_for_backup() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.export_cron_jobs_for_backup() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.export_cron_recent_runs_for_backup() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.export_realtime_publication_for_backup() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.export_storage_buckets_for_backup() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.export_pgmq_queues_for_backup() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.export_schema_ddl_for_backup() TO service_role;
GRANT EXECUTE ON FUNCTION public.export_auth_identities_for_backup() TO service_role;
GRANT EXECUTE ON FUNCTION public.export_auth_mfa_factors_for_backup() TO service_role;
GRANT EXECUTE ON FUNCTION public.export_auth_sessions_for_backup() TO service_role;
GRANT EXECUTE ON FUNCTION public.export_cron_jobs_for_backup() TO service_role;
GRANT EXECUTE ON FUNCTION public.export_cron_recent_runs_for_backup() TO service_role;
GRANT EXECUTE ON FUNCTION public.export_realtime_publication_for_backup() TO service_role;
GRANT EXECUTE ON FUNCTION public.export_storage_buckets_for_backup() TO service_role;
GRANT EXECUTE ON FUNCTION public.export_pgmq_queues_for_backup() TO service_role;
