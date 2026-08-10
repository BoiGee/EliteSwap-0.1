-- Closes an admin-dashboard gap left open by the shared-pool migration
-- (20260810154243_shared_decart_pool.sql): that migration's own comment
-- noted decart_shared_pool's admin RLS policy was added "for whenever a
-- UI gets built for this" — no UI existed yet, so the only way to view,
-- rotate, or add a Decart credential was a direct SQL session. Mirrors
-- log_api_key_pool_reveal's exact audit pattern (admin-only, logs to
-- admin_audit_logs) for the new DecartPoolManager admin UI.
CREATE OR REPLACE FUNCTION public.log_decart_shared_pool_reveal(p_pool_id uuid)
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
    actor_id, actor_email, actor_role, action, target_type, target_id, metadata
  ) VALUES (
    v_user, v_email, 'admin', 'decart_shared_pool_reveal', 'decart_shared_pool', p_pool_id,
    jsonb_build_object('is_active', v_row.is_active, 'note', v_row.note)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.log_decart_shared_pool_reveal(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_decart_shared_pool_reveal(uuid) TO authenticated;
