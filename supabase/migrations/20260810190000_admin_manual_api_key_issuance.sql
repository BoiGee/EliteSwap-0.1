-- UserManager.tsx already had a "+ Create Key" flow letting admin issue a
-- key to any user manually — but it inserted directly against api_keys,
-- and when the admin left "Custom secret" blank (the normal case), the
-- key column's own default (encode(gen_random_bytes(32),'hex')) produced a
-- 64-char hex key — the OLD long format, inconsistent with the 11-char
-- generate_short_access_key() format every other key on the platform has
-- used since the 2026-08-10 short-key migration. Nobody updated this path
-- when that migration ran. Verified against the live column default before
-- writing this fix.
--
-- Routes manual issuance through the same generator paid signups use, and
-- audits every manual grant (who issued it, to whom, how much time) since
-- this bypasses payment entirely — same audit pattern as
-- log_api_key_pool_reveal / log_decart_shared_pool_reveal.
CREATE OR REPLACE FUNCTION public.admin_issue_api_key(
  p_user_id uuid,
  p_label text DEFAULT NULL,
  p_remaining_ms bigint DEFAULT NULL,
  p_custom_key text DEFAULT NULL
)
RETURNS public.api_keys
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin uuid := auth.uid();
  v_email text;
  v_key text;
  v_row public.api_keys%ROWTYPE;
BEGIN
  IF v_admin IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.has_role(v_admin, 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = p_user_id) THEN
    RAISE EXCEPTION 'user_not_found';
  END IF;

  v_key := COALESCE(NULLIF(trim(p_custom_key), ''), public.generate_short_access_key());

  INSERT INTO public.api_keys (user_id, key, label, is_active, remaining_ms, payment_id, pool_key_id)
  VALUES (
    p_user_id,
    v_key,
    COALESCE(NULLIF(trim(p_label), ''), 'Admin-issued'),
    true,
    p_remaining_ms,
    NULL,
    NULL
  )
  RETURNING * INTO v_row;

  SELECT email INTO v_email FROM public.profiles WHERE user_id = v_admin;
  INSERT INTO public.admin_audit_logs (
    actor_id, actor_email, actor_role, action, target_type, target_id, metadata
  ) VALUES (
    v_admin, v_email, 'admin', 'manual_api_key_issued', 'api_keys', v_row.id,
    jsonb_build_object(
      'target_user_id', p_user_id,
      'label', v_row.label,
      'remaining_ms', p_remaining_ms,
      'custom_key_supplied', p_custom_key IS NOT NULL AND trim(p_custom_key) <> ''
    )
  );

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_issue_api_key(uuid, text, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_issue_api_key(uuid, text, bigint, text) TO authenticated;
