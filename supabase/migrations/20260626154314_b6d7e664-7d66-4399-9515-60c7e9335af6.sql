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
       SET status = 'failed', updated_at = now()
     WHERE id = p_purchase_id;
    v_result := jsonb_build_object('status','failed');

  ELSIF p_action = 'reset_pending' THEN
    UPDATE public.trial_purchases
       SET status = 'pending',
           provider_reference = NULL,
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