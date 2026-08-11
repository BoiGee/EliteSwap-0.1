-- Discounts tab audit. Found the discount system's actual enforcement is
-- non-functional at the point money changes hands — verified against live
-- code (0 redemptions ever recorded despite the feature existing) and
-- traced the exact mechanism.
--
-- THREE separate BEFORE INSERT triggers on payments all independently
-- validate/compute discount_code + discount_amount_usd + amount_usd:
-- payments_normalize_partner_credit (unrelated to discounts, skip),
-- payments_sanitize_client_insert_trg, tg_payments_normalize_amounts, and
-- trg_payments_enforce_financials — which fire in that alphabetical order
-- (Postgres fires same-timing triggers alphabetically by trigger name).
-- Whichever runs LAST wins, since each overwrites NEW.* set by the ones
-- before it: trg_payments_enforce_financials (function
-- payments_enforce_financials) sorts last of the four, so its output is
-- what actually gets persisted for every regular user payment.
--
-- BUG 1: payments_enforce_financials's discount validation checks
-- is_active / expires_at / applies_to_plan_ids / max_redemptions —
-- but never checks redemption_mode. A 'single_per_user' code (which
-- doesn't set max_redemptions — that's the other mode's field) sails
-- through the "(max_redemptions IS NULL OR times_redeemed <
-- max_redemptions)" check unconditionally, since NULL always passes.
-- tg_payments_normalize_amounts — the trigger one step earlier — DOES
-- check this correctly (queries discount_redemptions for a prior
-- redemption by this user+code), but its work gets thrown away the
-- moment the last trigger runs. Net effect: a "single per user" code can
-- be reused an unlimited number of times by the same person.
--
-- BUG 2 (more severe — makes bug 1's fix alone insufficient): nothing in
-- the entire codebase ever calls record_discount_redemption(), the one
-- function that actually inserts into discount_redemptions and increments
-- discount_codes.times_redeemed. Verified: zero callers anywhere in src/
-- or supabase/functions/, and discount_redemptions has stayed at 0 rows
-- since the feature was built. This means even a *correct* redemption_mode
-- check is checking against data that never exists — every discount code,
-- 'single_per_user' or 'multi_use_capped', can be reused without limit,
-- and a capped code's times_redeemed never advances so it can never
-- actually reach its cap. The discount IS correctly computed into the
-- payment's amount_usd (that part works), it's only usage tracking and
-- enforcement that's dead.
--
-- Fixed:
--  1. payments_enforce_financials now checks redemption_mode the same way
--     tg_payments_normalize_amounts already (correctly) does.
--  2. A new AFTER trigger calls record_discount_redemption the moment a
--     payment with a discount_code actually reaches 'confirmed' — not at
--     initial (pending) insert, so an abandoned/rejected payment attempt
--     never burns the user's redemption. record_discount_redemption
--     itself was already correct (idempotent per payment_id, increments
--     times_redeemed) — it just had no caller.

CREATE OR REPLACE FUNCTION public.payments_enforce_financials()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_plan_price numeric;
  v_plan_commission numeric;
  v_discount_pct integer;
  v_discount_amount numeric;
  v_code RECORD;
  v_already_used integer;
  v_code_valid boolean;
BEGIN
  -- Admins/service_role inserts (e.g. backfills) bypass enforcement
  IF auth.uid() IS NULL OR public.has_role(auth.uid(), 'admin'::app_role) THEN
    RETURN NEW;
  END IF;

  IF NEW.plan_id IS NULL THEN
    -- No plan -> force financials to NULL (verifier will reject anyway)
    NEW.amount_usd := NULL;
    NEW.discount_amount_usd := NULL;
    NEW.commission_pct_snapshot := NULL;
    NEW.commission_base_usd_snapshot := NULL;
    RETURN NEW;
  END IF;

  SELECT price_usd, commission_base_usd
    INTO v_plan_price, v_plan_commission
  FROM public.pricing_plans
  WHERE id = NEW.plan_id AND is_active = true;

  IF v_plan_price IS NULL THEN
    -- Unknown / inactive plan: null the financials
    NEW.amount_usd := NULL;
    NEW.discount_amount_usd := NULL;
    NEW.commission_pct_snapshot := NULL;
    NEW.commission_base_usd_snapshot := NULL;
    RETURN NEW;
  END IF;

  -- Resolve discount strictly from server-side discount_codes, including
  -- redemption_mode — a single_per_user code has no max_redemptions to
  -- check against, so that half of the validation has to be explicit.
  v_discount_amount := 0;
  IF NEW.discount_code IS NOT NULL AND length(btrim(NEW.discount_code)) > 0 THEN
    SELECT * INTO v_code
    FROM public.discount_codes
    WHERE upper(code) = upper(btrim(NEW.discount_code))
      AND is_active = true
      AND (expires_at IS NULL OR expires_at > now())
      AND (
        applies_to_plan_ids IS NULL
        OR array_length(applies_to_plan_ids, 1) IS NULL
        OR NEW.plan_id = ANY(applies_to_plan_ids)
      )
    LIMIT 1;

    v_code_valid := FOUND;
    IF v_code_valid AND v_code.redemption_mode = 'single_per_user' THEN
      SELECT COUNT(*) INTO v_already_used
      FROM public.discount_redemptions
      WHERE code_id = v_code.id AND user_id = NEW.user_id;
      v_code_valid := v_already_used = 0;
    ELSIF v_code_valid AND v_code.redemption_mode = 'multi_use_capped' THEN
      v_code_valid := v_code.times_redeemed < COALESCE(v_code.max_redemptions, 0);
    END IF;

    IF v_code_valid THEN
      v_discount_pct := v_code.percent_off;
      v_discount_amount := round((v_plan_price * v_discount_pct / 100.0)::numeric, 2);
    ELSE
      -- Invalid / already-used / exhausted code: clear it
      NEW.discount_code := NULL;
    END IF;
  ELSE
    NEW.discount_code := NULL;
  END IF;

  NEW.amount_usd := v_plan_price - v_discount_amount;
  NEW.discount_amount_usd := CASE WHEN v_discount_amount > 0 THEN v_discount_amount ELSE NULL END;
  NEW.commission_base_usd_snapshot := v_plan_commission;
  -- commission_pct_snapshot is driven by partner attribution elsewhere; null on user insert
  NEW.commission_pct_snapshot := NULL;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_payments_record_discount_redemption()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_redemption RECORD;
BEGIN
  IF NEW.discount_code IS NOT NULL
     AND ((TG_OP = 'INSERT' AND NEW.status = 'confirmed')
          OR (TG_OP = 'UPDATE' AND NEW.status = 'confirmed' AND COALESCE(OLD.status, '') <> 'confirmed'))
  THEN
    PERFORM public.record_discount_redemption(
      NEW.discount_code, NEW.user_id, NEW.id, COALESCE(NEW.discount_amount_usd, 0)
    );
  -- Reversal: a payment that was confirmed (and so already consumed a
  -- redemption slot) gets moved back off confirmed — e.g. an admin
  -- correction — give the slot back rather than leaving it permanently
  -- burned for a payment that ultimately didn't count.
  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'confirmed' AND NEW.status <> 'confirmed' THEN
    SELECT * INTO v_redemption FROM public.discount_redemptions WHERE payment_id = NEW.id;
    IF FOUND THEN
      DELETE FROM public.discount_redemptions WHERE id = v_redemption.id;
      UPDATE public.discount_codes
        SET times_redeemed = GREATEST(times_redeemed - 1, 0), updated_at = now()
        WHERE id = v_redemption.code_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_payments_record_discount_redemption ON public.payments;
CREATE TRIGGER trg_payments_record_discount_redemption
  AFTER INSERT OR UPDATE OF status ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.tg_payments_record_discount_redemption();
