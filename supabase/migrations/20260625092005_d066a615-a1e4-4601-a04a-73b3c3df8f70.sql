
-- 1. app_notifications table
CREATE TABLE IF NOT EXISTS public.app_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  category text NOT NULL CHECK (category IN ('payment','security','key','admin_post','forum','system')),
  kind text NOT NULL,
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','success','warning','critical')),
  title text NOT NULL,
  body text,
  href text,
  target_kind text,
  target_id uuid,
  actor_id uuid,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, UPDATE ON public.app_notifications TO authenticated;
GRANT ALL ON public.app_notifications TO service_role;

CREATE INDEX IF NOT EXISTS idx_app_notif_user_created ON public.app_notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_notif_user_unread ON public.app_notifications(user_id) WHERE read_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_app_notif_user_kind_target
  ON public.app_notifications(user_id, kind, target_id)
  WHERE target_id IS NOT NULL;

ALTER TABLE public.app_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owner reads own notifications"
  ON public.app_notifications FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id OR public.has_role('admin'::app_role));

CREATE POLICY "Owner updates own notifications"
  ON public.app_notifications FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.app_notifications;
ALTER TABLE public.app_notifications REPLICA IDENTITY FULL;

-- 2. helper to insert
CREATE OR REPLACE FUNCTION public.app_notify(
  p_user_id uuid, p_category text, p_kind text, p_title text,
  p_body text DEFAULT NULL, p_href text DEFAULT NULL,
  p_severity text DEFAULT 'info',
  p_target_kind text DEFAULT NULL, p_target_id uuid DEFAULT NULL,
  p_actor_id uuid DEFAULT NULL, p_data jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF p_user_id IS NULL THEN RETURN NULL; END IF;
  INSERT INTO public.app_notifications
    (user_id, category, kind, severity, title, body, href, target_kind, target_id, actor_id, data)
  VALUES (p_user_id, p_category, p_kind, p_severity, p_title, p_body, p_href, p_target_kind, p_target_id, p_actor_id, p_data)
  ON CONFLICT (user_id, kind, target_id) WHERE target_id IS NOT NULL DO UPDATE
    SET title = EXCLUDED.title, body = EXCLUDED.body, severity = EXCLUDED.severity,
        href = EXCLUDED.href, data = EXCLUDED.data, read_at = NULL,
        created_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- 3. Payments triggers
CREATE OR REPLACE FUNCTION public.tg_notify_payment_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_admin uuid;
  v_title text;
  v_body text;
  v_sev text := 'info';
  v_kind text;
  v_status_changed boolean;
BEGIN
  v_status_changed := (TG_OP = 'INSERT') OR (NEW.status IS DISTINCT FROM OLD.status);
  IF NOT v_status_changed THEN RETURN NEW; END IF;

  IF NEW.status = 'pending' AND TG_OP = 'INSERT' THEN
    v_kind := 'payment_created';
    v_title := 'Payment received — awaiting confirmation';
    v_body := 'We received your payment submission and are verifying it.';
    v_sev := 'info';
  ELSIF NEW.status = 'confirmed' THEN
    v_kind := 'payment_confirmed';
    v_title := 'Payment confirmed ✅';
    v_body := 'Your payment was confirmed. Your API key is being issued.';
    v_sev := 'success';
  ELSIF NEW.status = 'underpaid' THEN
    v_kind := 'payment_underpaid';
    v_title := 'Underpayment detected';
    v_body := 'The amount received is less than the plan price. Please top up to activate.';
    v_sev := 'warning';
  ELSIF NEW.status IN ('failed','rejected','expired') THEN
    v_kind := 'payment_failed';
    v_title := 'Payment ' || NEW.status;
    v_body := 'Open your dashboard to retry or contact support.';
    v_sev := 'warning';
  ELSE
    RETURN NEW;
  END IF;

  -- Notify owner
  PERFORM public.app_notify(
    NEW.user_id, 'payment', v_kind, v_title, v_body,
    '/dashboard', v_sev, 'payment', NEW.id, NULL,
    jsonb_build_object('status', NEW.status, 'amount_usd', NEW.amount_usd)
  );

  -- Notify admins (only on new pending + on confirmed)
  IF v_kind IN ('payment_created','payment_confirmed','payment_underpaid') THEN
    FOR v_admin IN SELECT user_id FROM public.user_roles WHERE role = 'admin'::app_role LOOP
      PERFORM public.app_notify(
        v_admin, 'payment',
        'admin_' || v_kind,
        CASE v_kind
          WHEN 'payment_created' THEN 'New payment submitted'
          WHEN 'payment_confirmed' THEN 'Payment confirmed'
          WHEN 'payment_underpaid' THEN 'Underpaid payment'
        END,
        'User ' || COALESCE((SELECT email FROM public.profiles WHERE user_id = NEW.user_id), NEW.user_id::text)
          || ' — ' || COALESCE(NEW.amount_usd::text, '?') || ' USD',
        '/admin', v_sev, 'payment', NEW.id, NEW.user_id,
        jsonb_build_object('status', NEW.status, 'amount_usd', NEW.amount_usd)
      );
    END LOOP;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS notify_payment_event ON public.payments;
CREATE TRIGGER notify_payment_event
  AFTER INSERT OR UPDATE OF status ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.tg_notify_payment_event();

-- 4. Login security trigger
CREATE OR REPLACE FUNCTION public.tg_notify_login()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ip text; v_ua text;
BEGIN
  IF NEW.action <> 'login' THEN RETURN NEW; END IF;
  v_ip := COALESCE(NEW.metadata->>'ip','');
  v_ua := COALESCE(NEW.metadata->>'ua','');
  INSERT INTO public.app_notifications
    (user_id, category, kind, severity, title, body, href, target_kind, target_id, data)
  VALUES (
    NEW.user_id, 'security', 'login_new', 'info',
    'New sign-in to your account',
    'Sign-in detected' || CASE WHEN v_ua <> '' THEN ' from ' || left(v_ua, 80) ELSE '' END,
    '/dashboard', 'session', NEW.id,
    jsonb_build_object('ip', v_ip, 'ua', v_ua)
  );
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS notify_login ON public.user_activity_logs;
CREATE TRIGGER notify_login
  AFTER INSERT ON public.user_activity_logs
  FOR EACH ROW WHEN (NEW.action = 'login')
  EXECUTE FUNCTION public.tg_notify_login();

-- 5. Admin forum post → fan-out to all users
CREATE OR REPLACE FUNCTION public.tg_notify_admin_forum_thread()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.posted_as_admin IS NOT TRUE THEN RETURN NEW; END IF;
  INSERT INTO public.app_notifications
    (user_id, category, kind, severity, title, body, href, target_kind, target_id, actor_id, data)
  SELECT p.user_id, 'admin_post', 'admin_thread', 'warning',
         '📢 New announcement from EliteSwap',
         NEW.title,
         '/forum/t/' || NEW.id::text,
         'thread', NEW.id, NEW.author_id,
         jsonb_build_object('title', NEW.title)
  FROM public.profiles p
  ON CONFLICT (user_id, kind, target_id) WHERE target_id IS NOT NULL DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS notify_admin_forum_thread ON public.forum_threads;
CREATE TRIGGER notify_admin_forum_thread
  AFTER INSERT ON public.forum_threads
  FOR EACH ROW EXECUTE FUNCTION public.tg_notify_admin_forum_thread();

CREATE OR REPLACE FUNCTION public.tg_notify_admin_forum_reply()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_title text;
BEGIN
  IF NEW.posted_as_admin IS NOT TRUE THEN RETURN NEW; END IF;
  SELECT title INTO v_title FROM public.forum_threads WHERE id = NEW.thread_id;
  INSERT INTO public.app_notifications
    (user_id, category, kind, severity, title, body, href, target_kind, target_id, actor_id, data)
  SELECT p.user_id, 'admin_post', 'admin_reply', 'warning',
         '📢 Admin replied in: ' || COALESCE(v_title, 'a thread'),
         left(NEW.body_md, 160),
         '/forum/t/' || NEW.thread_id::text,
         'reply', NEW.id, NEW.author_id,
         jsonb_build_object('thread_id', NEW.thread_id)
  FROM public.profiles p
  ON CONFLICT (user_id, kind, target_id) WHERE target_id IS NOT NULL DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS notify_admin_forum_reply ON public.forum_replies;
CREATE TRIGGER notify_admin_forum_reply
  AFTER INSERT ON public.forum_replies
  FOR EACH ROW EXECUTE FUNCTION public.tg_notify_admin_forum_reply();

-- 6. Mirror forum_notifications into app_notifications
CREATE OR REPLACE FUNCTION public.tg_mirror_forum_notifications()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_title text; v_href text;
BEGIN
  v_title := CASE NEW.kind
    WHEN 'reply' THEN 'New reply to your thread'
    WHEN 'mention' THEN 'You were mentioned'
    WHEN 'solution' THEN 'Your reply was marked as solution'
    WHEN 'media_approved' THEN 'Your media was approved'
    WHEN 'media_rejected' THEN 'Your media was rejected'
    WHEN 'report_resolved' THEN 'A report you filed was reviewed'
    ELSE 'Community update'
  END;
  v_href := CASE
    WHEN NEW.target_kind::text = 'thread' AND NEW.target_id IS NOT NULL THEN '/forum/t/' || NEW.target_id::text
    WHEN NEW.target_kind::text = 'reply' AND (NEW.data->>'thread_id') IS NOT NULL THEN '/forum/t/' || (NEW.data->>'thread_id')
    ELSE '/forum/me'
  END;
  INSERT INTO public.app_notifications
    (user_id, category, kind, severity, title, body, href, target_kind, target_id, actor_id, data)
  VALUES (
    NEW.user_id, 'forum', 'forum_' || NEW.kind, 'info', v_title,
    COALESCE(NEW.data->>'thread_title', NULL),
    v_href, NEW.target_kind::text, NEW.target_id, NEW.actor_id, NEW.data
  )
  ON CONFLICT (user_id, kind, target_id) WHERE target_id IS NOT NULL DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS mirror_forum_notifications ON public.forum_notifications;
CREATE TRIGGER mirror_forum_notifications
  AFTER INSERT ON public.forum_notifications
  FOR EACH ROW EXECUTE FUNCTION public.tg_mirror_forum_notifications();

-- 7. Key expiry checker
CREATE OR REPLACE FUNCTION public.notify_keys_expiring()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r RECORD; v_remaining_min int; v_count int := 0;
BEGIN
  FOR r IN
    SELECT id, user_id, label, expires_at, remaining_ms, is_active
    FROM public.api_keys
    WHERE (is_active = true AND expires_at IS NOT NULL AND expires_at > now() AND expires_at <= now() + interval '10 minutes')
       OR (is_active = false AND last_session_ended_at > now() - interval '15 minutes' AND remaining_ms <= 0)
  LOOP
    IF r.expires_at IS NOT NULL AND r.expires_at > now() THEN
      v_remaining_min := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (r.expires_at - now()))/60)::int);
      PERFORM public.app_notify(
        r.user_id, 'key', 'key_expiring',
        'API key has ' || v_remaining_min || ' min left',
        COALESCE(r.label,'Your key') || ' is about to expire. Save your work.',
        '/dashboard', 'warning', 'api_key', r.id, NULL,
        jsonb_build_object('remaining_minutes', v_remaining_min)
      );
    ELSE
      PERFORM public.app_notify(
        r.user_id, 'key', 'key_expired',
        'API key expired',
        COALESCE(r.label,'Your key') || ' has run out of time.',
        '/dashboard', 'critical', 'api_key', r.id, NULL,
        '{}'::jsonb
      );
    END IF;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

-- Schedule every 5 minutes (no secrets; safe in migration)
DO $$
BEGIN
  PERFORM cron.unschedule('notify-keys-expiring');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'notify-keys-expiring',
  '*/5 * * * *',
  $$ SELECT public.notify_keys_expiring(); $$
);
