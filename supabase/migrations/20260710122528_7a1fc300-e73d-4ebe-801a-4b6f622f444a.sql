CREATE OR REPLACE FUNCTION public.log_api_key_pool_reveal(p_pool_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_email text;
  v_row public.api_key_pool%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT (public.has_role(v_user, 'admin'::public.app_role)
       OR public.has_role(v_user, 'sec_admin'::public.app_role)) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  SELECT * INTO v_row FROM public.api_key_pool WHERE id = p_pool_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'pool_row_not_found'; END IF;

  SELECT email INTO v_email FROM public.profiles WHERE user_id = v_user;

  INSERT INTO public.admin_audit_logs (
    actor_id, actor_email, actor_role, action, target_type, target_id, metadata
  ) VALUES (
    v_user, v_email, 'admin', 'api_key_pool_reveal', 'api_key_pool', p_pool_id,
    jsonb_build_object(
      'plan_id', v_row.plan_id,
      'status', v_row.status,
      'assigned_to_user_id', v_row.assigned_to_user_id
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.log_api_key_pool_reveal(uuid) TO authenticated;