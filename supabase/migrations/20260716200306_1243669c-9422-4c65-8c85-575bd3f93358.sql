
-- Extend log_admin_action so that when the actor is a sec_admin (and not also
-- an admin), we fire a real-time push/in-app notification to every admin.
-- The audit row is still written the same way — this only adds a fan-out.

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
      RETURN;
    END IF;

    PERFORM net.http_post(
      url := 'https://clxdvyeumnvmalxbymwh.supabase.co/functions/v1/notify-sec-admin-action',
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
  END;
END;
$$;

-- Retire the older, narrower sec-admin payment INSERT trigger — the new
-- fan-out inside log_admin_action supersedes it and covers every action type.
DROP TRIGGER IF EXISTS trg_payments_notify_admin_on_sec_admin_insert ON public.payments;
