-- Store the project ref + service key in vault-ish settings for the trigger.
-- We use current_setting fallbacks so this works even if vault isn't wired.
CREATE OR REPLACE FUNCTION public.trigger_admin_push_support()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  supabase_url text := 'https://clxdvyeumnvmalxbymwh.supabase.co';
  service_key text;
  preview text;
BEGIN
  IF NEW.is_admin THEN
    RETURN NEW;
  END IF;
  BEGIN
    SELECT decrypted_secret INTO service_key
    FROM vault.decrypted_secrets
    WHERE name = 'email_queue_service_role_key'
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    service_key := NULL;
  END;
  IF service_key IS NULL THEN
    RETURN NEW;
  END IF;
  preview := left(coalesce(NEW.content, ''), 80);
  PERFORM net.http_post(
    url := supabase_url || '/functions/v1/send-admin-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    body := jsonb_build_object(
      'event', 'support_message',
      'title', 'New support message',
      'body', preview,
      'url', '/admin',
      'tag', 'support-' || NEW.conversation_id
    )
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.trigger_admin_push_forum_report()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  supabase_url text := 'https://clxdvyeumnvmalxbymwh.supabase.co';
  service_key text;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO service_key
    FROM vault.decrypted_secrets
    WHERE name = 'email_queue_service_role_key'
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    service_key := NULL;
  END;
  IF service_key IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM net.http_post(
    url := supabase_url || '/functions/v1/send-admin-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    body := jsonb_build_object(
      'event', 'forum_report',
      'title', 'New forum report',
      'body', coalesce(NEW.reason, '') || ' • ' || coalesce(NEW.target_kind::text, ''),
      'url', '/admin',
      'tag', 'report-' || NEW.id
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_admin_push_support ON public.support_messages;
CREATE TRIGGER trg_admin_push_support
AFTER INSERT ON public.support_messages
FOR EACH ROW EXECUTE FUNCTION public.trigger_admin_push_support();

DROP TRIGGER IF EXISTS trg_admin_push_forum_report ON public.forum_reports;
CREATE TRIGGER trg_admin_push_forum_report
AFTER INSERT ON public.forum_reports
FOR EACH ROW EXECUTE FUNCTION public.trigger_admin_push_forum_report();
