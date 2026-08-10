
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS payment_funnel_stage integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_funnel_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_payment_nudge_sent_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_profiles_funnel_stage ON public.profiles (payment_funnel_stage);
CREATE INDEX IF NOT EXISTS idx_profiles_funnel_updated ON public.profiles (payment_funnel_updated_at DESC);

CREATE OR REPLACE FUNCTION public.tg_update_payment_funnel_stage()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_stage integer := 0;
BEGIN
  -- Map the action to a stage number. Higher = further along the funnel.
  v_new_stage := CASE NEW.action
    WHEN 'funnel_pricing_viewed'         THEN 1
    WHEN 'funnel_plan_selected'          THEN 2
    WHEN 'funnel_payment_method_chosen'  THEN 3
    WHEN 'funnel_crypto_qr_viewed'       THEN 4
    WHEN 'funnel_crypto_address_copied'  THEN 5
    WHEN 'funnel_paystack_opened'        THEN 5
    WHEN 'funnel_tx_hash_submitted'      THEN 6
    WHEN 'funnel_paystack_returned'      THEN 7
    WHEN 'funnel_payment_confirmed'      THEN 8
    ELSE 0
  END;

  IF v_new_stage > 0 THEN
    UPDATE public.profiles
    SET payment_funnel_stage = v_new_stage,
        payment_funnel_updated_at = now()
    WHERE user_id = NEW.user_id
      AND payment_funnel_stage < v_new_stage;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_update_payment_funnel_stage ON public.user_activity_logs;
CREATE TRIGGER trg_update_payment_funnel_stage
AFTER INSERT ON public.user_activity_logs
FOR EACH ROW
EXECUTE FUNCTION public.tg_update_payment_funnel_stage();
