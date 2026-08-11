-- Partners tab audit. Two real gaps found and fixed, verified against live
-- data.
--
-- GAP 1: 13 of 17 existing partner records (76%) have no matching 'partner'
-- row in user_roles. PartnerManager.tsx's createPartner() does this as two
-- separate, unguarded client calls — INSERT partners, then a second INSERT
-- into user_roles whose result is never checked (no error handling, no
-- rollback) before showing "Partner created". The 13 affected rows' code
-- values (8-char hex, e.g. 5BEC4820, CEF4AB3D) strongly suggest they were
-- bulk-seeded directly via SQL rather than through the UI, which would
-- explain them specifically — but the UI path itself is still fragile: any
-- transient failure on the second insert leaves the exact same silent gap
-- with no indication to the admin. The 'partner' role isn't currently
-- checked by any RLS policy or frontend route (verified: grepped the whole
-- codebase, zero references outside this admin tab) so nothing is broken
-- today, but it's exactly the kind of latent gap that breaks a future
-- feature silently. Fixed by making creation one atomic RPC instead of two
-- independent client calls, and backfilling the 13 missing role grants.
--
-- GAP 2: admin_set_partner_parent() had no cycle protection — an admin
-- could set partner A's parent to one of A's own descendants (or to
-- itself), and every override-earnings computation (tg_payments_write_-
-- override_ledger, tg_partners_backfill_overrides_on_parent_change,
-- admin_rebuild_override_ledger) would walk the resulting loop up to their
-- 20-iteration bound, repeatedly overwriting the same 1-2 beneficiary rows
-- (harmless financially due to the ON CONFLICT(payment_id,
-- beneficiary_partner_id) dedup, but wasteful) while corrupting the
-- downline tree the admin actually looks at. No cycle currently exists in
-- live data (verified), but the frontend's parent-picker dropdown only
-- excludes the partner itself, not its descendants, so this was one
-- misclick away from happening. Fixed by rejecting self-parenting and any
-- assignment that would create a cycle.

CREATE OR REPLACE FUNCTION public.admin_create_partner(
  p_user_id uuid,
  p_code text,
  p_display_name text,
  p_commission_pct numeric
)
RETURNS public.partners
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_partner public.partners;
  v_code text := upper(trim(p_code));
BEGIN
  IF NOT has_role('admin'::app_role) THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR v_code = '' THEN
    RAISE EXCEPTION 'User and code are required';
  END IF;
  IF p_commission_pct IS NULL OR p_commission_pct <= 0 OR p_commission_pct > 100 THEN
    RAISE EXCEPTION 'Commission %% must be between 0 and 100';
  END IF;

  INSERT INTO public.partners (user_id, code, display_name, commission_pct)
  VALUES (p_user_id, v_code, NULLIF(trim(COALESCE(p_display_name, '')), ''), p_commission_pct)
  RETURNING * INTO v_partner;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (p_user_id, 'partner'::app_role)
  ON CONFLICT (user_id, role) DO NOTHING;

  RETURN v_partner;
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_create_partner(uuid, text, text, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_create_partner(uuid, text, text, numeric) TO authenticated;

-- One-time backfill for the 13 partners already missing the role.
INSERT INTO public.user_roles (user_id, role)
SELECT p.user_id, 'partner'::app_role
FROM public.partners p
ON CONFLICT (user_id, role) DO NOTHING;

CREATE OR REPLACE FUNCTION public.admin_set_partner_parent(p_partner_id uuid, p_parent_partner_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cur uuid;
  v_depth int := 0;
BEGIN
  IF NOT has_role('admin'::app_role) THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;

  IF p_parent_partner_id IS NOT NULL THEN
    IF p_parent_partner_id = p_partner_id THEN
      RAISE EXCEPTION 'A partner cannot be its own parent' USING ERRCODE = '23514';
    END IF;

    -- Walk up from the proposed parent; if we ever reach p_partner_id,
    -- assigning it would create a cycle.
    v_cur := p_parent_partner_id;
    WHILE v_cur IS NOT NULL AND v_depth < 20 LOOP
      IF v_cur = p_partner_id THEN
        RAISE EXCEPTION 'That would create a circular referral chain' USING ERRCODE = '23514';
      END IF;
      v_depth := v_depth + 1;
      SELECT parent_partner_id INTO v_cur FROM public.partners WHERE id = v_cur;
    END LOOP;
  END IF;

  UPDATE public.partners
    SET parent_partner_id = p_parent_partner_id,
        updated_at = now()
    WHERE id = p_partner_id;
END;
$function$;
