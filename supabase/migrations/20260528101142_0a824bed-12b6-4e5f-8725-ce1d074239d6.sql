CREATE OR REPLACE FUNCTION public.create_partner_self()
RETURNS public.partners
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_existing public.partners;
  v_new public.partners;
  v_code text;
  v_display text;
  v_parent uuid;
  v_attempts int := 0;
  v_has_payment boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_existing FROM public.partners WHERE user_id = v_uid LIMIT 1;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.payments
    WHERE user_id = v_uid AND status = 'confirmed'
  ) INTO v_has_payment;

  IF NOT v_has_payment THEN
    RAISE EXCEPTION 'Partner Program is available after your first confirmed purchase';
  END IF;

  SELECT display_name INTO v_display FROM public.profiles WHERE user_id = v_uid LIMIT 1;

  SELECT partner_id INTO v_parent
  FROM public.partner_attributions
  WHERE user_id = v_uid
  ORDER BY attributed_at ASC
  LIMIT 1;

  LOOP
    v_attempts := v_attempts + 1;
    v_code := upper(substr(encode(extensions.gen_random_bytes(5), 'hex'), 1, 8));
    BEGIN
      INSERT INTO public.partners (user_id, code, display_name, commission_pct, override_pct, is_active, parent_partner_id)
      VALUES (v_uid, v_code, v_display, 20, 5, true, v_parent)
      RETURNING * INTO v_new;
      RETURN v_new;
    EXCEPTION WHEN unique_violation THEN
      IF v_attempts >= 5 THEN RAISE; END IF;
    END;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.create_partner_self() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_partner_self() TO authenticated;