-- Funnel tab audit found a severe, currently-active bug, plus two smaller
-- ones. All verified against live data before fixing.
--
-- THE BIG ONE: trg_profiles_guard_funnel (BEFORE UPDATE ON profiles) blocks
-- any change to payment_funnel_stage/last_payment_nudge_sent_at/
-- payment_funnel_updated_at/email/user_id unless the caller is admin or
-- service_role. But tg_update_payment_funnel_stage — the trigger that's
-- SUPPOSED to advance a regular user's own funnel stage as they browse
-- pricing/checkout — runs as that regular user's own session, which is
-- neither. Its UPDATE has "WHERE payment_funnel_stage < v_new_stage", so
-- the guard only actually fires (BEFORE UPDATE triggers only run for rows
-- that match the WHERE clause) on a genuine NEW stage advancement — repeat
-- visits from users already past that stage silently no-op with zero rows
-- affected, which is why user_activity_logs kept accumulating fine (765
-- funnel_pricing_viewed rows, latest today) while masking that real
-- advancement has been silently failing. Verified directly: the most
-- recent genuine (non-backfilled) stage update in profiles was 2026-06-20
-- — seven weeks of real traffic with zero real advancement since. 1,211
-- profiles currently sit at stage 0, every one of them permanently unable
-- to ever enter the funnel until this is fixed. trackFunnel() swallows all
-- errors silently by design ("never blocks the UX"), so nobody could have
-- seen this happening.
--
-- Fixed by giving the guard a bypass flag using the same established
-- pattern as app.bypass_key_guard elsewhere in this codebase, and having
-- every legitimate system trigger/RPC that needs to touch these fields set
-- it first — the guard's whole job (stopping an arbitrary client-side
-- UPDATE from forging these fields) is untouched; only trusted, already
-- role-checked or logic-checked server-side paths bypass it.
--
-- Also fixes (see previous version's header comment, unchanged in intent):
--  2. Stage 8 was unreachable — trackFunnel("funnel_payment_confirmed") is
--     never called anywhere, and structurally never could be (confirmation
--     always happens outside the paying user's own browser session).
--     Replaced with a server-side trigger + one-time backfill.
--  3. PaymentNudgeDialog's direct client .update() on profiles silently
--     failed for sec_admin (profiles' only UPDATE RLS policy is admin-only)
--     — moved into a small SECURITY DEFINER RPC scoped to exactly this one
--     field instead of broadening the general profiles UPDATE policy.

CREATE OR REPLACE FUNCTION public.tg_profiles_guard_funnel()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_setting('app.bypass_profiles_guard', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF (NEW.payment_funnel_stage IS DISTINCT FROM OLD.payment_funnel_stage
      OR NEW.last_payment_nudge_sent_at IS DISTINCT FROM OLD.last_payment_nudge_sent_at
      OR NEW.payment_funnel_updated_at IS DISTINCT FROM OLD.payment_funnel_updated_at
      OR NEW.email IS DISTINCT FROM OLD.email
      OR NEW.user_id IS DISTINCT FROM OLD.user_id)
     AND NOT public.has_role('admin'::app_role)
     AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Not allowed to modify protected profile fields' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.tg_update_payment_funnel_stage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_stage integer := 0;
BEGIN
  v_new_stage := CASE NEW.action
    WHEN 'funnel_pricing_viewed'         THEN 1
    WHEN 'funnel_plan_selected'          THEN 2
    WHEN 'funnel_payment_method_chosen'  THEN 3
    WHEN 'funnel_crypto_qr_viewed'       THEN 4
    WHEN 'funnel_crypto_address_copied'  THEN 5
    WHEN 'funnel_tx_hash_submitted'      THEN 6
    WHEN 'funnel_payment_confirmed'      THEN 8
    ELSE 0
  END;

  IF v_new_stage > 0 THEN
    PERFORM set_config('app.bypass_profiles_guard', 'on', true);
    UPDATE public.profiles
    SET payment_funnel_stage = v_new_stage,
        payment_funnel_updated_at = now()
    WHERE user_id = NEW.user_id
      AND payment_funnel_stage < v_new_stage;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.tg_payments_advance_funnel_stage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'confirmed' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    PERFORM set_config('app.bypass_profiles_guard', 'on', true);
    UPDATE public.profiles
       SET payment_funnel_stage = 8,
           payment_funnel_updated_at = now()
     WHERE user_id = NEW.user_id
       AND payment_funnel_stage < 8;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payments_advance_funnel_stage ON public.payments;
CREATE TRIGGER trg_payments_advance_funnel_stage
  AFTER INSERT OR UPDATE OF status ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.tg_payments_advance_funnel_stage();

-- One-time backfill for existing confirmed payments predating this trigger.
-- (Re-run is idempotent — the WHERE clause only matches rows still behind.)
DO $$ BEGIN PERFORM set_config('app.bypass_profiles_guard', 'on', true); END $$;
UPDATE public.profiles p
   SET payment_funnel_stage = 8,
       payment_funnel_updated_at = now()
  FROM public.payments pay
 WHERE pay.user_id = p.user_id
   AND pay.status = 'confirmed'
   AND p.payment_funnel_stage < 8;

CREATE OR REPLACE FUNCTION public.record_payment_nudge_sent(
  p_user_id uuid,
  p_preset_id text,
  p_subject text,
  p_headline_snippet text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.can_manage_payments(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  INSERT INTO public.payment_nudge_history (user_id, preset_id, sent_by, subject, headline_snippet)
  VALUES (p_user_id, p_preset_id, auth.uid(), p_subject, p_headline_snippet);

  PERFORM set_config('app.bypass_profiles_guard', 'on', true);
  UPDATE public.profiles
     SET last_payment_nudge_sent_at = now()
   WHERE user_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_payment_nudge_sent(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_payment_nudge_sent(uuid, text, text, text) TO authenticated;
