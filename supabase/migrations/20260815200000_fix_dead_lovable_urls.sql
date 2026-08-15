-- Full-repo audit (2026-08-15) found two live automations still pointing at
-- the decommissioned Lovable project (clxdvyeumnvmalxbymwh.supabase.co)
-- instead of the current one (bbxahisheugfryyxfidg.supabase.co). Both have
-- been silently no-oping since the 2026-08-10 migration cutover:
--
-- 1) The nightly 'daily-db-backup' cron (originally scheduled in
--    20260615105532) has never been rescheduled with the correct URL — only
--    the admin panel's manual "Run Backup Now" button (which calls the edge
--    function directly from the browser) has actually been running backups.
--
-- 2) log_admin_action()'s sec-admin fan-out (20260716200306) still posts to
--    the dead URL. The EXCEPTION WHEN OTHERS handler around it is correct
--    (a notification failure must never roll back the audit log insert) but
--    it means every failure has gone to the Postgres logs only — nowhere an
--    admin would ever see it. This migration also mirrors that failure into
--    admin_audit_logs itself, using the same table the fan-out was trying to
--    surface in the first place, so a future outage is visible in-app.
--
-- Also drops tg_payments_notify_admin_on_sec_admin_insert(): its trigger was
-- already dropped in 20260716200306 (superseded by log_admin_action's own
-- fan-out) but the function itself was left behind, dead code with the same
-- stale URL baked in.

-- 1) Re-point the nightly backup cron.
DO $$
DECLARE
  v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'daily-db-backup';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;

  PERFORM cron.schedule(
    'daily-db-backup',
    '0 2 * * *',
    $cron$
    SELECT net.http_post(
      url := 'https://bbxahisheugfryyxfidg.supabase.co/functions/v1/daily-db-backup',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key' LIMIT 1)
      ),
      body := jsonb_build_object('trigger', 'cron')
    );
    $cron$
  );
END $$;

-- 2) Re-point log_admin_action()'s sec-admin fan-out and make a failed
--    fan-out visible in admin_audit_logs instead of only a Postgres WARNING.
CREATE OR REPLACE FUNCTION public.log_admin_action(
  _action TEXT,
  _target_type TEXT,
  _target_id TEXT,
  _before JSONB,
  _after JSONB,
  _metadata JSONB DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid UUID := auth.uid();
  email TEXT;
  role_label TEXT;
  v_service_key TEXT;
  v_is_admin BOOLEAN := false;
  v_is_sec BOOLEAN := false;
BEGIN
  IF uid IS NULL THEN
    role_label := 'system';
  ELSE
    SELECT p.email INTO email FROM public.profiles p WHERE p.user_id = uid LIMIT 1;
    v_is_admin := public.has_role(uid, 'admin'::public.app_role);
    v_is_sec := public.has_role(uid, 'sec_admin'::public.app_role);
    IF v_is_admin THEN role_label := 'admin';
    ELSIF v_is_sec THEN role_label := 'sec_admin';
    ELSIF public.has_role(uid, 'moderator'::public.app_role) THEN role_label := 'moderator';
    ELSE role_label := 'user';
    END IF;
  END IF;

  INSERT INTO public.admin_audit_logs
    (actor_id, actor_email, actor_role, action, target_type, target_id, before_data, after_data, metadata)
  VALUES
    (uid, email, role_label, _action, _target_type, _target_id, _before, _after, COALESCE(_metadata, '{}'::jsonb));

  -- Fan out ONLY when the actor is a sec_admin and not also a full admin.
  IF NOT v_is_sec OR v_is_admin THEN
    RETURN;
  END IF;

  BEGIN
    SELECT decrypted_secret INTO v_service_key
    FROM vault.decrypted_secrets
    WHERE name = 'email_queue_service_role_key'
    LIMIT 1;

    IF v_service_key IS NULL THEN
      RAISE WARNING 'log_admin_action: missing email_queue_service_role_key, skipping fan-out';
      INSERT INTO public.admin_audit_logs
        (actor_id, actor_email, actor_role, action, target_type, target_id, before_data, after_data, metadata)
      VALUES
        (NULL, NULL, 'system', 'sec_admin_notify_failed', _target_type, _target_id, NULL, NULL,
         jsonb_build_object('reason', 'missing email_queue_service_role_key', 'original_action', _action));
      RETURN;
    END IF;

    PERFORM net.http_post(
      url := 'https://bbxahisheugfryyxfidg.supabase.co/functions/v1/notify-sec-admin-action',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_service_key
      ),
      body := jsonb_build_object(
        'action', _action,
        'targetType', _target_type,
        'targetId', _target_id,
        'actorEmail', email,
        'actorRole', role_label,
        'beforeData', _before,
        'afterData', _after,
        'metadata', COALESCE(_metadata, '{}'::jsonb)
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'log_admin_action fan-out failed: %', SQLERRM;
    BEGIN
      INSERT INTO public.admin_audit_logs
        (actor_id, actor_email, actor_role, action, target_type, target_id, before_data, after_data, metadata)
      VALUES
        (NULL, NULL, 'system', 'sec_admin_notify_failed', _target_type, _target_id, NULL, NULL,
         jsonb_build_object('reason', SQLERRM, 'original_action', _action));
    EXCEPTION WHEN OTHERS THEN
      NULL; -- never let the visibility insert itself break the caller
    END;
  END;
END;
$$;

-- 3) Drop the orphaned function left behind after its trigger was retired.
DROP FUNCTION IF EXISTS public.tg_payments_notify_admin_on_sec_admin_insert();
