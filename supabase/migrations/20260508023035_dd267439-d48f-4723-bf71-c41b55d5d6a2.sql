-- Drop Paystack-specific column and index
DROP INDEX IF EXISTS public.payments_paystack_reference_key;
ALTER TABLE public.payments DROP COLUMN IF EXISTS paystack_reference;

-- Replace user INSERT policy on payments to only allow crypto method
DROP POLICY IF EXISTS "Users can insert own payments" ON public.payments;
CREATE POLICY "Users can insert own payments"
ON public.payments
FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = user_id
  AND status IN ('pending', 'pending_review')
  AND payment_method = 'crypto'
);

-- Replace funnel trigger function: remove paystack stages
CREATE OR REPLACE FUNCTION public.tg_update_payment_funnel_stage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
    UPDATE public.profiles
    SET payment_funnel_stage = v_new_stage,
        payment_funnel_updated_at = now()
    WHERE user_id = NEW.user_id
      AND payment_funnel_stage < v_new_stage;
  END IF;

  RETURN NEW;
END;
$function$;