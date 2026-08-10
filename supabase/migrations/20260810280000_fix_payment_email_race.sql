-- Payments tab audit found a real race between the admin's custom
-- approval/rejection email and a generic fallback, both targeting the
-- same customer with the same idempotency key.
--
-- tg_payments_dispatch_emails fires on every payments.status change to
-- confirmed/rejected — unconditionally, regardless of source — and always
-- calls notify-admin-payment-event with a hardcoded generic note. Meanwhile
-- PaymentActionDialog (the "Approve"/"Reject" flow) ALSO sends its own
-- richer, admin-composed email directly (custom preset or free-text note),
-- using the identical idempotency key format (payment-{id}-confirmed /
-- -rejected). Resend's own idempotency handling prevents the customer from
-- getting two emails, but WHICH content actually reaches them is decided
-- by network race timing, not by design — the trigger fires synchronously
-- within the same UPDATE transaction the dialog just committed, so it
-- reaches the queue first far more often than not. Net effect: an admin's
-- carefully written rejection reason (e.g. "wrong amount sent, please
-- resend X") has a real chance of being silently replaced by a generic
-- "we couldn't verify this payment" message with no explanation — and the
-- dialog's own "Send email notification" toggle doesn't even prevent this,
-- since the trigger fires independently of that client-side choice.
--
-- Fixed by having admin_set_payment_status() OPTIONALLY suppress the
-- trigger via a transaction-local flag (same established pattern as
-- app.bypass_key_guard used elsewhere), gated behind a new p_suppress_notify
-- parameter that defaults to false. Deliberately NOT suppressed
-- unconditionally: UserManager.tsx has its own separate inline approve/
-- reject flow that calls this exact same RPC but has no direct
-- email-sending step of its own — it relies entirely on the trigger to
-- notify the customer. Verified this before writing the fix; suppressing
-- unconditionally would have silently broken customer emails for every
-- payment approved through that path. Only PaymentActionDialog (which
-- always sends its own richer email right after this call) passes
-- p_suppress_notify := true. Every other caller keeps today's behavior
-- exactly as-is.
CREATE OR REPLACE FUNCTION public.tg_payments_dispatch_emails()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_event text;
  v_service_key text;
BEGIN
  IF current_setting('app.suppress_payment_dispatch', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  IF NEW.status NOT IN ('confirmed', 'rejected') THEN RETURN NEW; END IF;
  v_event := CASE WHEN NEW.status = 'confirmed' THEN 'auto_confirmed' ELSE 'admin_rejected' END;
  SELECT decrypted_secret INTO v_service_key FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key' LIMIT 1;
  IF v_service_key IS NULL THEN RETURN NEW; END IF;
  PERFORM net.http_post(
    url := 'https://bbxahisheugfryyxfidg.supabase.co/functions/v1/notify-admin-payment-event',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_service_key),
    body := jsonb_build_object('paymentId', NEW.id::text, 'eventType', v_event)
  );
  RETURN NEW;
END;
$function$;

-- Adding a parameter via CREATE OR REPLACE does not replace the old
-- signature — Postgres treats differing parameter counts as a distinct
-- overload, so the old 4-arg version must be dropped explicitly or PostgREST
-- callers using named JSON parameters become ambiguous between the two
-- (verified live: this exact ambiguity broke both callers immediately
-- after applying this migration without the DROP, caught before shipping).
DROP FUNCTION IF EXISTS public.admin_set_payment_status(uuid, text, uuid, numeric);

CREATE OR REPLACE FUNCTION public.admin_set_payment_status(p_payment_id uuid, p_status text, p_plan_id uuid DEFAULT NULL::uuid, p_amount_usd numeric DEFAULT NULL::numeric, p_suppress_notify boolean DEFAULT false)
 RETURNS payments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_payment      public.payments%ROWTYPE;
  v_target       public.payments%ROWTYPE;
  v_conflict     public.payments%ROWTYPE;
  v_conflict_email text;
BEGIN
  IF NOT (public.has_role(auth.uid(), 'admin'::app_role)
       OR public.has_role(auth.uid(), 'sec_admin'::app_role)) THEN
    RAISE EXCEPTION 'Not authorized to manage payments' USING ERRCODE = '42501';
  END IF;

  IF p_status NOT IN ('confirmed', 'rejected') THEN
    RAISE EXCEPTION 'Invalid payment status' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_target FROM public.payments WHERE id = p_payment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_status = 'confirmed'
     AND COALESCE(v_target.payment_method, '') = 'crypto'
     AND v_target.tx_hash IS NOT NULL
     AND length(v_target.tx_hash) >= 32 THEN

    SELECT * INTO v_conflict
    FROM public.payments
    WHERE id <> p_payment_id
      AND status = 'confirmed'
      AND payment_method = 'crypto'
      AND tx_hash IS NOT NULL
      AND lower(tx_hash) = lower(v_target.tx_hash)
    LIMIT 1;

    IF FOUND THEN
      IF v_conflict.user_id = v_target.user_id THEN
        RETURN v_conflict;
      END IF;

      SELECT email INTO v_conflict_email
      FROM auth.users WHERE id = v_conflict.user_id;

      RAISE EXCEPTION
        'This transaction hash is already credited to payment % (user %). Reject this duplicate instead of approving.',
        v_conflict.id, COALESCE(v_conflict_email, v_conflict.user_id::text)
        USING ERRCODE = '23505';
    END IF;
  END IF;

  -- Opt-in only (see header comment) — PaymentActionDialog passes true
  -- because it always sends its own richer, customizable email directly
  -- right after this call returns. UserManager's inline flow leaves this
  -- false and keeps relying on the trigger, unchanged.
  IF p_suppress_notify THEN
    PERFORM set_config('app.suppress_payment_dispatch', 'on', true);
  END IF;

  BEGIN
    UPDATE public.payments
    SET status = p_status,
        plan_id = CASE WHEN p_status = 'confirmed' AND p_plan_id IS NOT NULL THEN p_plan_id ELSE plan_id END,
        amount_usd = CASE WHEN p_status = 'confirmed' AND p_amount_usd IS NOT NULL THEN p_amount_usd ELSE amount_usd END,
        updated_at = now()
    WHERE id = p_payment_id
    RETURNING * INTO v_payment;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_conflict
    FROM public.payments
    WHERE id <> p_payment_id
      AND status = 'confirmed'
      AND payment_method = 'crypto'
      AND tx_hash IS NOT NULL
      AND lower(tx_hash) = lower(v_target.tx_hash)
    LIMIT 1;

    IF FOUND AND v_conflict.user_id = v_target.user_id THEN
      RETURN v_conflict;
    END IF;

    SELECT email INTO v_conflict_email
    FROM auth.users WHERE id = COALESCE(v_conflict.user_id, v_target.user_id);

    RAISE EXCEPTION
      'This transaction hash is already credited to another confirmed payment (user %). Reject this duplicate instead of approving.',
      COALESCE(v_conflict_email, 'unknown')
      USING ERRCODE = '23505';
  END;

  RETURN v_payment;
END;
$function$;
