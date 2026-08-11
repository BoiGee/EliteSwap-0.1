-- Admin notifications audit: the user reported that submitted-transaction
-- notifications and their details weren't reaching admins. Traced every
-- payment-submission notification path and found the root cause.
--
-- app_notifications (the table backing the bell icon — NotificationBell.tsx
-- / useAppNotifications.ts) was never added to the supabase_realtime
-- publication. useAppNotifications subscribes via postgres_changes for
-- live INSERT/UPDATE events to drive the toast, the unread badge, and the
-- document-title counter — but Postgres never replicates change events for
-- a table that isn't in the publication, so that subscription silently
-- never fires. Confirmed live: 477 payment-category notifications exist in
-- app_notifications with fully correct details (amount, who, status) and
-- are correctly addressed to both admin accounts — the data was never the
-- problem. Every single one has read_at = NULL, consistent with an admin
-- who has to reload the page to ever see a new one instead of it arriving
-- live. This is the fix that actually closes the reported gap.
--
-- Separately (same root investigation, smaller in scope): the sec_admin
-- role is excluded from admin notification fan-out in two DB triggers —
-- tg_notify_payment_event() and tg_alert_manual_payment_confirm() both
-- loop only over user_roles WHERE role = 'admin', even though
-- can_manage_payments() (the actual authorization gate for handling
-- payments) treats admin and sec_admin as equally privileged. There is
-- currently 1 sec_admin account live who has never received an in-app
-- payment notification of any kind as a result. Widened both loops to
-- match can_manage_payments()'s definition of "who handles payments."
-- (send-admin-push's own admin/moderator role query has the same
-- sec_admin gap — fixed in the edge function alongside this migration.)

ALTER PUBLICATION supabase_realtime ADD TABLE public.app_notifications;

CREATE OR REPLACE FUNCTION public.tg_notify_payment_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
    v_body := 'Your payment was confirmed. Your unique key is being issued.';
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
    FOR v_admin IN SELECT user_id FROM public.user_roles WHERE role IN ('admin'::app_role, 'sec_admin'::app_role) LOOP
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
END;
$$;

CREATE OR REPLACE FUNCTION public.tg_alert_manual_payment_confirm()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_email text;
  v_actor_role text;
  v_who text;
  v_title text;
  v_body text;
  v_admin uuid;
  v_service text;
  v_url text := 'https://bbxahisheugfryyxfidg.supabase.co';
  v_born boolean;
  v_noproof boolean;
BEGIN
  -- Only when a human (signed-in staff) is behind it; cron/verifier has no auth.uid()
  IF v_actor IS NULL THEN RETURN NEW; END IF;
  IF NEW.status <> 'confirmed' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'confirmed' THEN RETURN NEW; END IF;

  -- Only staff actions matter here
  IF NOT public.is_staff(v_actor) THEN RETURN NEW; END IF;

  SELECT email INTO v_actor_email FROM public.profiles WHERE user_id = v_actor LIMIT 1;
  SELECT role::text INTO v_actor_role FROM public.user_roles
    WHERE user_id = v_actor ORDER BY (role = 'admin'::app_role) DESC LIMIT 1;

  SELECT COALESCE(display_name, email, NEW.user_id::text) INTO v_who
    FROM public.profiles WHERE user_id = NEW.user_id LIMIT 1;

  v_born := (TG_OP = 'INSERT');
  v_noproof := (NULLIF(NEW.tx_hash,'') IS NULL);

  v_title := format('%s marked a $%s payment as PAID',
    COALESCE(split_part(v_actor_email,'@',1), 'A staff member'),
    trim(to_char(COALESCE(NEW.amount_usd,0),'FM999999990.00')));

  v_body := trim(both ' ' from concat_ws(' ',
    'For ' || COALESCE(v_who,'a user') || '.',
    CASE WHEN v_noproof THEN 'No transaction hash was provided.' ELSE NULL END,
    CASE WHEN v_born THEN 'It was created already paid — a key was issued instantly.' ELSE NULL END,
    CASE WHEN v_actor_role = 'sec_admin' THEN 'Done by a SEC ADMIN.' ELSE NULL END
  ));

  -- In-app bell for every admin AND sec_admin (both handle payments per can_manage_payments())
  FOR v_admin IN SELECT user_id FROM public.user_roles WHERE role IN ('admin'::app_role, 'sec_admin'::app_role) LOOP
    PERFORM public.app_notify(
      v_admin, 'payment', 'admin_manual_confirm', v_title, v_body,
      '/admin?tab=staff_activity',
      CASE WHEN v_noproof OR v_born THEN 'warning' ELSE 'info' END,
      'payment', NEW.id, v_actor,
      jsonb_build_object('amount_usd', NEW.amount_usd, 'actor_email', v_actor_email,
                         'actor_role', v_actor_role, 'no_proof', v_noproof, 'born_confirmed', v_born)
    );
  END LOOP;

  -- Push
  BEGIN
    SELECT decrypted_secret INTO v_service FROM vault.decrypted_secrets
      WHERE name = 'email_queue_service_role_key' LIMIT 1;
  EXCEPTION WHEN OTHERS THEN v_service := NULL;
  END;

  IF v_service IS NOT NULL THEN
    PERFORM net.http_post(
      url := v_url || '/functions/v1/send-admin-push',
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_service),
      body := jsonb_build_object(
        'event','staff_manual_confirm',
        'title', v_title,
        'body', v_body,
        'url','/admin?tab=staff_activity',
        'tag','staff-confirm-' || NEW.id
      )
    );
  END IF;

  RETURN NEW;
END;
$$;
