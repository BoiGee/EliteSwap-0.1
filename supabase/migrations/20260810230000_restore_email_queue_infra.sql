-- Every transactional email (payment confirmed/rejected, trial activated,
-- payment nudges, admin broadcasts) has silently failed to send since the
-- migration off Lovable. Root-caused via direct verification, not
-- assumption: the pgmq extension itself was never installed on this
-- project (CREATE EXTENSION pgmq lived in the original 20260415235536
-- migration but the new DB's schema came from a backup restore, not a
-- migration replay, so it never ran) — confirmed live by calling
-- enqueue_email() directly and getting `schema "pgmq" does not exist`.
-- email_send_log's most recent row before this fix was 2026-08-10T01:10Z,
-- hours before the migration cutover — zero rows since, confirmed via
-- direct query, not inference.
--
-- Separately, even with pgmq restored, nothing was draining the queue:
-- a later migration (20260702181703) re-scheduled the 'process-email-queue'
-- cron job but hardcoded the OLD Lovable-managed project's URL
-- (clxdvyeumnvmalxbymwh.supabase.co) — and it was never applied here
-- either (cron.job has zero rows for this job name, confirmed live).
-- cron_invoke_edge() already exists, already targets the correct current
-- project, and already authenticates with the Vault-stored service-role
-- key that sync-internal-service-key-daily keeps fresh — reusing it
-- instead of hand-rolling a new net.http_post block.

CREATE EXTENSION IF NOT EXISTS pgmq;

DO $$ BEGIN PERFORM pgmq.create('auth_emails'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN PERFORM pgmq.create('transactional_emails'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN PERFORM pgmq.create('auth_emails_dlq'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN PERFORM pgmq.create('transactional_emails_dlq'); EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$
DECLARE
  v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'process-email-queue';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;
  PERFORM cron.schedule(
    'process-email-queue',
    '5 seconds',
    $cron$SELECT public.cron_invoke_edge('process-email-queue');$cron$
  );
END $$;
