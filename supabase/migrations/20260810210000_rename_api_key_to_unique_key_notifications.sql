-- Display-text rename only: "API key" -> "unique key" in the two live
-- functions that generate in-app notification titles/bodies shown to paid
-- users (app_notifications, surfaced via NotificationBell). No column,
-- table, or function name changes — the app_notify() target_type tag
-- 'api_key' is left as-is since it's an internal classification, not
-- displayed text.
CREATE OR REPLACE FUNCTION public.tg_notify_payment_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
END $function$;

CREATE OR REPLACE FUNCTION public.notify_keys_expiring()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
        'Unique key has ' || v_remaining_min || ' min left',
        COALESCE(r.label,'Your key') || ' is about to expire. Save your work.',
        '/dashboard', 'warning', 'api_key', r.id, NULL,
        jsonb_build_object('remaining_minutes', v_remaining_min)
      );
    ELSE
      PERFORM public.app_notify(
        r.user_id, 'key', 'key_expired',
        'Unique key expired',
        COALESCE(r.label,'Your key') || ' has run out of time.',
        '/dashboard', 'critical', 'api_key', r.id, NULL,
        '{}'::jsonb
      );
    END IF;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $function$;
