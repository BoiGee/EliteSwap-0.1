
CREATE OR REPLACE FUNCTION public.tg_payments_notify_admin_on_sec_admin_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_is_sec boolean := false;
  v_is_admin boolean := false;
  v_actor_email text;
  v_service_key text;
BEGIN
  -- Only react when invoked by an authenticated user (skip system/cron writes).
  IF v_caller IS NULL THEN
    RETURN NEW;
  END IF;

  v_is_sec := public.has_role(v_caller, 'sec_admin'::public.app_role);
  v_is_admin := public.has_role(v_caller, 'admin'::public.app_role);

  -- Only notify when the actor is a Sec Admin and not also an Admin.
  IF NOT v_is_sec OR v_is_admin THEN
    RETURN NEW;
  END IF;

  SELECT email INTO v_actor_email FROM auth.users WHERE id = v_caller LIMIT 1;

  SELECT decrypted_secret INTO v_service_key
  FROM vault.decrypted_secrets
  WHERE name = 'email_queue_service_role_key'
  LIMIT 1;

  IF v_service_key IS NULL THEN
    RAISE WARNING 'tg_payments_notify_admin_on_sec_admin_insert: missing email_queue_service_role_key';
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url := 'https://clxdvyeumnvmalxbymwh.supabase.co/functions/v1/notify-admin-payment-event',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_service_key
    ),
    body := jsonb_build_object(
      'paymentId', NEW.id,
      'eventType', 'sec_admin_added',
      'actorEmail', v_actor_email,
      'actorRole', 'sec_admin'
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'tg_payments_notify_admin_on_sec_admin_insert failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payments_notify_admin_on_sec_admin_insert ON public.payments;
CREATE TRIGGER trg_payments_notify_admin_on_sec_admin_insert
AFTER INSERT ON public.payments
FOR EACH ROW
EXECUTE FUNCTION public.tg_payments_notify_admin_on_sec_admin_insert();
