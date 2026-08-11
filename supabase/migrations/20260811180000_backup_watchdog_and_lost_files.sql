-- Backups tab audit found two problems with the daily backup pipeline:
--
-- 1. Stuck-run detection was far too slow. The function's own stale-run
--    reaper only ran at the START of the NEXT invocation, and since this
--    function is normally only invoked once a day, a crashed run could
--    misrepresent "running" in the admin tab for up to 24 hours. Live
--    history showed a 64% failure rate (9 of 14 runs), almost all
--    "timed_out_or_crashed". The edge function itself was fixed alongside
--    this migration (the actual backup work now runs behind
--    EdgeRuntime.waitUntil so it's no longer bound by the synchronous
--    HTTP response ceiling that was causing the timeouts) and gained a
--    lightweight mode=reap_only fast path that this watchdog cron calls
--    every 15 minutes, so a stuck run is caught within 15-20 minutes
--    instead of up to a day.
--
-- 2. All historical "successful" backups from before the Lovable ->
--    standalone Supabase migration point to files that no longer exist.
--    The db-backups storage bucket was recreated empty on this project
--    (created at the same instant as every other bucket during the
--    migration window, 2026-08-10T06:21:37) and the old project's backup
--    zips were never copied over. Confirmed directly: storage.objects for
--    bucket_id='db-backups' contains only the backup produced by this
--    migration's own test run; the four earlier rows' storage_path values
--    have no matching object. Those rows are marked below so the admin UI
--    stops offering a Download link that can only 500, while preserving
--    the historical record that a backup did run successfully that day.
SELECT cron.schedule(
  'db-backup-reap-watchdog',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://bbxahisheugfryyxfidg.supabase.co/functions/v1/daily-db-backup',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key' LIMIT 1)
    ),
    body := jsonb_build_object('mode', 'reap_only')
  );
  $$
);

-- One-time: reap any run stuck in 'running' right now rather than waiting
-- for the first watchdog tick.
UPDATE public.backup_runs
   SET status = 'failed', error_message = 'timed_out_or_crashed', finished_at = now()
 WHERE status = 'running'
   AND started_at < now() - interval '20 minutes';

-- One-time: flag the pre-migration backups whose files are confirmed gone.
UPDATE public.backup_runs
   SET storage_path = NULL,
       download_url = NULL,
       error_message = 'File lost during the Aug 2026 platform migration off Lovable — the storage bucket was recreated empty on the new Supabase project and the old file was never copied over. Backup metadata is preserved for the historical record; the zip itself is unrecoverable.'
 WHERE status = 'success'
   AND storage_path IN (
     '2026/06/backup-2026-06-15.zip',
     '2026/07/backup-2026-07-12.zip',
     '2026/07/backup-2026-07-19.zip',
     '2026/08/backup-2026-08-10.zip'
   );
