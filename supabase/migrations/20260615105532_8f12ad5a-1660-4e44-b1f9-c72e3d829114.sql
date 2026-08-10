
-- 1) backup_runs table
CREATE TABLE public.backup_runs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running', -- running | success | failed
  table_count INTEGER,
  total_rows BIGINT,
  file_size_bytes BIGINT,
  storage_path TEXT,
  download_url TEXT,
  error_message TEXT,
  triggered_by TEXT NOT NULL DEFAULT 'cron', -- cron | manual
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.backup_runs TO authenticated;
GRANT ALL ON public.backup_runs TO service_role;

ALTER TABLE public.backup_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view backup runs"
  ON public.backup_runs FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- 2) Storage policies for db-backups bucket (admins only via signed URLs / function calls)
CREATE POLICY "Admins can read db-backups"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'db-backups' AND public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Service role manages db-backups"
  ON storage.objects FOR ALL
  TO service_role
  USING (bucket_id = 'db-backups')
  WITH CHECK (bucket_id = 'db-backups');

-- 3) Cron job: daily at 02:00 UTC
SELECT cron.schedule(
  'daily-db-backup',
  '0 2 * * *',
  $$
  SELECT net.http_post(
    url := 'https://clxdvyeumnvmalxbymwh.supabase.co/functions/v1/daily-db-backup',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key' LIMIT 1)
    ),
    body := jsonb_build_object('trigger', 'cron')
  );
  $$
);
