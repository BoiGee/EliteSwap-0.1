-- User-requested (2026-08-12): whenever a payment is created/confirmed by
-- someone other than the primary admin (elotetoolz@gmail.com), send a push
-- notification flagging exactly who did it. Prompted by investigating
-- Melon2134@outlook.com's payment (cf6454ac-82d0...): a $210 "Professional"
-- payment inserted directly as status='confirmed' with tx_hash=null,
-- created_at==updated_at (never went through the normal pending -> verified
-- flow at all). Confirmed legitimate — the owner identified it as a
-- sec_admin (jaylengentry25@gmail.com, who legitimately has
-- can_manage_payments() via the sec_admin role) manually granting access —
-- but there was NO audit trail for it at all: admin_issue_api_key() logs to
-- admin_audit_logs, but a direct INSERT/UPDATE on payments via the
-- "Payment managers can insert/update payments" RLS policies does not.
--
-- This closes that visibility gap generally, not just for this one case:
-- it fires on ANY payment that becomes 'confirmed' where the acting
-- Postgres role's auth.uid() is a real, non-NULL user who isn't the
-- primary admin. NULL auth.uid() (the automated on-chain verifier, which
-- runs via a service-role client with no user JWT context) is deliberately
-- excluded — that's expected normal operation, not a manual override, and
-- already covered by the existing "Payment confirmed" push from
-- trigger_admin_push_payment. This one is specifically for humans other
-- than the primary admin exercising privileged access, whether that's
-- another staff member (as here) or, in the case of a not-yet-discovered
-- future hole, someone who shouldn't have that access at all.
CREATE OR REPLACE FUNCTION public.tg_payments_notify_non_primary_confirm()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  supabase_url text := 'https://bbxahisheugfryyxfidg.supabase.co';
  service_key text;
  v_actor uuid := auth.uid();
  v_primary_admin_id uuid;
  v_actor_email text;
  v_actor_role text;
  v_target_who text;
  became_confirmed boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    became_confirmed := NEW.status = 'confirmed';
  ELSIF TG_OP = 'UPDATE' THEN
    became_confirmed := NEW.status = 'confirmed' AND OLD.status IS DISTINCT FROM 'confirmed';
  END IF;

  IF NOT became_confirmed OR v_actor IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_primary_admin_id FROM auth.users WHERE email = 'elotetoolz@gmail.com' LIMIT 1;
  IF v_primary_admin_id IS NOT NULL AND v_actor = v_primary_admin_id THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT decrypted_secret INTO service_key
    FROM vault.decrypted_secrets
    WHERE name = 'email_queue_service_role_key'
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN service_key := NULL;
  END;
  IF service_key IS NULL THEN RETURN NEW; END IF;

  SELECT u.email, COALESCE(ur.role::text, 'no role')
    INTO v_actor_email, v_actor_role
    FROM auth.users u
    LEFT JOIN public.user_roles ur ON ur.user_id = u.id
   WHERE u.id = v_actor
   LIMIT 1;

  SELECT COALESCE(email, display_name, NEW.user_id::text) INTO v_target_who
    FROM public.profiles WHERE user_id = NEW.user_id LIMIT 1;

  PERFORM net.http_post(
    url := supabase_url || '/functions/v1/send-admin-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    body := jsonb_build_object(
      'event', 'payment_confirmed_by_non_primary',
      'title', '⚠️ Payment confirmed by someone other than you',
      'body', concat_ws(' • ',
        COALESCE(v_actor_email, v_actor::text) || ' (' || COALESCE(v_actor_role, 'no role') || ')',
        '$' || COALESCE(NEW.amount_usd::text, '?') || ' for ' || COALESCE(v_target_who, NEW.user_id::text)
      ),
      'url', '/admin',
      'tag', 'payment-non-primary-confirm-' || NEW.id
    )
  );
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_payments_notify_non_primary_confirm ON public.payments;
CREATE TRIGGER trg_payments_notify_non_primary_confirm
  AFTER INSERT OR UPDATE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.tg_payments_notify_non_primary_confirm();
