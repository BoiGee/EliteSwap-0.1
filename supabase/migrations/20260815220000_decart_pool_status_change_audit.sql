-- Full-repo audit (2026-08-15): deactivating a shared Decart key affects
-- every paid user's studio connection immediately, but unlike revealKey
-- (audited via log_decart_shared_pool_reveal) and removeKey (confirm
-- dialog), setActive had neither a confirmation step nor an audit trail.
-- Mirrors log_decart_shared_pool_reveal's exact pattern for the status
-- change; the frontend confirm dialog is added separately in
-- DecartPoolManager.tsx.
CREATE OR REPLACE FUNCTION public.log_decart_shared_pool_status_change(p_pool_id uuid, p_is_active boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_email text;
  v_row public.decart_shared_pool%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.has_role(v_user, 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  SELECT * INTO v_row FROM public.decart_shared_pool WHERE id = p_pool_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'pool_row_not_found'; END IF;

  SELECT email INTO v_email FROM public.profiles WHERE user_id = v_user;

  INSERT INTO public.admin_audit_logs (
    actor_id, actor_email, actor_role, action, target_type, target_id, before_data, after_data
  ) VALUES (
    v_user, v_email, 'admin', 'decart_shared_pool_status_change', 'decart_shared_pool', p_pool_id,
    jsonb_build_object('is_active', v_row.is_active),
    jsonb_build_object('is_active', p_is_active)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.log_decart_shared_pool_status_change(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_decart_shared_pool_status_change(uuid, boolean) TO authenticated;
