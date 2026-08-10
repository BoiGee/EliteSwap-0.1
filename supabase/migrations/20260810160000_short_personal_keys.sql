-- Shorten user-facing access keys to 11 random alphanumeric characters
-- (62-char alphabet, ~65.5 bits of entropy — 62^11 ≈ 5.2e19 combinations).
-- Chosen deliberately as a full a-zA-Z0-9 alphabet, not digits-only: the
-- /obs-output route is NOT behind login (OBS Studio itself can't do a
-- Supabase Auth session), so the key must stand on its own as a bearer
-- secret there, unlike mint_studio_credentials which also requires
-- matching auth.uid() ownership.
--
-- NOT included here (deliberately — one-time data operations, not
-- replayable schema): the mass regeneration of all existing api_keys.key
-- values via generate_short_access_key(), and the system_announcements
-- row telling users to re-copy their OBS URL. Both were run once, live,
-- on 2026-08-10, immediately after this migration. Re-running this file
-- against a fresh environment intentionally does NOT redo either.
--
-- api_keys.key had NO unique constraint or index at all before this —
-- verified against the live schema. The old real Decart-key-shaped values
-- were unique by construction (distinct real credentials), not by DB
-- enforcement. Adding a real constraint now that keys are randomly
-- generated in a (much smaller, though still enormous) keyspace. 0
-- existing duplicate values confirmed before adding.

-- Guard: fail loudly if this ever isn't true instead of silently adding
-- a constraint that would immediately be violated.
DO $$
DECLARE v_dupes int;
BEGIN
  SELECT count(*) INTO v_dupes FROM (SELECT key FROM public.api_keys GROUP BY key HAVING count(*) > 1) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION 'Refusing to add unique constraint: % duplicate key value(s) exist', v_dupes;
  END IF;
END $$;

ALTER TABLE public.api_keys ADD CONSTRAINT api_keys_key_unique UNIQUE (key);

CREATE OR REPLACE FUNCTION public.generate_short_access_key()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_alphabet text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  v_token text;
  v_i int;
BEGIN
  LOOP
    v_token := '';
    FOR v_i IN 1..11 LOOP
      v_token := v_token || substr(v_alphabet, (floor(random() * length(v_alphabet)) + 1)::int, 1);
    END LOOP;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.api_keys WHERE key = v_token);
  END LOOP;
  RETURN v_token;
END;
$$;

REVOKE ALL ON FUNCTION public.generate_short_access_key() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_short_access_key() TO service_role;

-- issue_api_key_for_payment: use the short generator for future signups
-- instead of the esw_-prefixed 52-char token from the previous migration.
CREATE OR REPLACE FUNCTION public.issue_api_key_for_payment(p_payment_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_payment    public.payments%ROWTYPE;
  v_minutes    INTEGER;
  v_plan_name  TEXT;
  v_new_key_id UUID;
  v_new_token  TEXT;
  v_caller     UUID := auth.uid();
  v_role       TEXT := auth.role();
  v_can_manage BOOLEAN := false;
BEGIN
  SELECT * INTO v_payment FROM public.payments WHERE id = p_payment_id;
  IF NOT FOUND OR v_payment.status <> 'confirmed' THEN
    RETURN NULL;
  END IF;

  IF v_caller IS NOT NULL THEN
    v_can_manage := public.can_manage_payments(v_caller);
  END IF;

  IF v_role <> 'service_role'
     AND (v_caller IS NULL
          OR (v_caller <> v_payment.user_id AND NOT v_can_manage)) THEN
    RAISE EXCEPTION 'not authorized to issue key for this payment';
  END IF;

  IF EXISTS (SELECT 1 FROM public.api_keys WHERE payment_id = p_payment_id) THEN
    UPDATE public.payments SET pending_key_assignment = false WHERE id = p_payment_id;
    RETURN NULL;
  END IF;

  IF v_payment.plan_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT key_duration_minutes, name
    INTO v_minutes, v_plan_name
    FROM public.pricing_plans
    WHERE id = v_payment.plan_id;

  IF v_minutes IS NULL OR v_minutes <= 0 THEN
    RETURN NULL;
  END IF;

  v_new_token := public.generate_short_access_key();

  INSERT INTO public.api_keys (user_id, key, label, is_active, remaining_ms, payment_id, pool_key_id)
  VALUES (
    v_payment.user_id,
    v_new_token,
    v_plan_name,
    true,
    (v_minutes::BIGINT) * 60000,
    v_payment.id,
    NULL
  )
  RETURNING id INTO v_new_key_id;

  UPDATE public.payments SET pending_key_assignment = false WHERE id = p_payment_id;

  RETURN v_new_key_id;
END;
$function$;
