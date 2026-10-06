-- $10 trial fixes (checked against production data, 2026-10-13):
-- 1. activation_emailed_at: customers were only told their trial was live when the USDT
--    checkout verifier confirmed it. Every admin-confirmed trial (manual Mobile Money,
--    Binance off-chain, rescued failures) got a key and no email. reconcile-trial-purchases
--    now emails any confirmed trial with a key that hasn't been told yet. Existing confirmed
--    trials are backfilled as already notified, so nobody gets a late or duplicate email.
-- 2. Reopen wiped provider_reference (the customer's tx hash / Mobile Money reference) and
--    left created_at old, so the 2-minute cron expired the purchase again right away. It now
--    keeps the reference, and the cron measures its 24h expiry from the last update.

ALTER TABLE public.trial_purchases ADD COLUMN IF NOT EXISTS activation_emailed_at timestamptz;

-- Keep each row's real updated_at; the backfill isn't an activity on the purchase.
ALTER TABLE public.trial_purchases DISABLE TRIGGER trial_purchases_set_updated;
UPDATE public.trial_purchases
   SET activation_emailed_at = COALESCE(confirmed_at, updated_at)
 WHERE status = 'confirmed'
   AND assigned_key_id IS NOT NULL
   AND activation_emailed_at IS NULL;
ALTER TABLE public.trial_purchases ENABLE TRIGGER trial_purchases_set_updated;

CREATE OR REPLACE FUNCTION public.admin_manage_trial_purchase(p_purchase_id uuid, p_action text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_purchase record;
  v_assign_row record;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.has_role(v_actor, 'admin'::app_role) OR public.has_role(v_actor, 'sec_admin'::app_role)) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_purchase FROM public.trial_purchases WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'trial purchase not found';
  END IF;

  IF p_action = 'confirm' THEN
    UPDATE public.trial_purchases
       SET status = 'confirmed',
           confirmed_at = COALESCE(confirmed_at, now()),
           needs_admin_review = false,
           updated_at = now()
     WHERE id = p_purchase_id;

    IF v_purchase.assigned_key_id IS NULL THEN
      SELECT * INTO v_assign_row FROM public.assign_trial_key_from_purchase(p_purchase_id) LIMIT 1;
      v_result := jsonb_build_object(
        'status', 'confirmed',
        'assigned', v_assign_row.api_key IS NOT NULL,
        'api_key_preview', CASE WHEN v_assign_row.api_key IS NOT NULL THEN left(v_assign_row.api_key, 6) || '…' ELSE NULL END,
        'expires_at', v_assign_row.expires_at
      );
    ELSE
      v_result := jsonb_build_object('status','confirmed','assigned', true, 'note','key already assigned');
    END IF;

  ELSIF p_action = 'reject' THEN
    UPDATE public.trial_purchases
       SET status = 'failed', needs_admin_review = false, updated_at = now()
     WHERE id = p_purchase_id;
    v_result := jsonb_build_object('status','failed');

  ELSIF p_action = 'reset_pending' THEN
    -- Keeps provider_reference: it's the customer's proof of payment, and the cron re-checks it.
    UPDATE public.trial_purchases
       SET status = 'pending',
           needs_admin_review = false,
           updated_at = now()
     WHERE id = p_purchase_id;
    v_result := jsonb_build_object('status','pending');

  ELSE
    RAISE EXCEPTION 'invalid action: %', p_action;
  END IF;

  INSERT INTO public.user_activity_logs(user_id, action, page, metadata)
  VALUES (v_actor, 'admin_trial_action', '/admin', jsonb_build_object('purchase_id', p_purchase_id, 'action', p_action, 'target_user_id', v_purchase.user_id));

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_manage_trial_purchase(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_manage_trial_purchase(uuid, text) TO authenticated;
