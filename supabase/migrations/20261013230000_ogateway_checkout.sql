-- OGateway checkout for plans: Mobile Money (MTN / Telecel / AirtelTigo) and cards, charged in
-- GHS. Off until gateway_checkout_enabled is switched on.
--
-- Flow: create-plan-checkout calls create_gateway_payment() as the signed-in user, so the
-- existing insert triggers price the plan, validate the discount and snapshot the commission
-- exactly as for crypto. The function then opens an OGateway checkout and records its id here.
-- ogateway-webhook / verify-ogateway-payment confirm the payment only after reading its status
-- back from OGateway's API, through auto_confirm_payment_from_verifier() like the crypto
-- verifier, so key issuing, partner credit and emails run through the same triggers.

ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_currency_check;
ALTER TABLE public.payments ADD CONSTRAINT payments_currency_check
  CHECK (currency = ANY (ARRAY['BTC', 'BNB', 'USDT-BEP20', 'USDT-TRC20', 'GHS']));

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS provider_reference text,
  ADD COLUMN IF NOT EXISTS amount_local numeric,
  ADD COLUMN IF NOT EXISTS fx_rate numeric;

CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_reference_key
  ON public.payments (provider_reference) WHERE provider_reference IS NOT NULL;

ALTER TABLE public.studio_pricing_config
  ADD COLUMN IF NOT EXISTS gateway_checkout_enabled boolean NOT NULL DEFAULT false;

-- Public: lets the pricing UI decide whether to offer the Mobile Money / card button.
CREATE OR REPLACE FUNCTION public.payment_options()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object('gateway_checkout', COALESCE((SELECT gateway_checkout_enabled FROM public.studio_pricing_config WHERE id = true), false));
$$;
REVOKE ALL ON FUNCTION public.payment_options() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payment_options() TO anon, authenticated, service_role;

-- Called with the customer's own session (auth.uid() set), so payments_sanitize_client_insert
-- and payments_enforce_financials price it. Returns the priced row.
CREATE OR REPLACE FUNCTION public.create_gateway_payment(p_plan_id uuid, p_discount_code text DEFAULT NULL)
RETURNS public.payments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.payments%ROWTYPE;
  v_recent integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in required' USING ERRCODE = '42501';
  END IF;
  IF NOT COALESCE((SELECT gateway_checkout_enabled FROM public.studio_pricing_config WHERE id = true), false) THEN
    RAISE EXCEPTION 'Mobile Money and card checkout is not available yet' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pricing_plans WHERE id = p_plan_id AND is_active AND price_usd > 0) THEN
    RAISE EXCEPTION 'Choose a plan to pay for' USING ERRCODE = '22023';
  END IF;

  -- Each checkout opens a pending row; stop a stuck button from opening dozens.
  SELECT count(*) INTO v_recent
    FROM public.payments
   WHERE user_id = v_uid AND payment_method = 'ogateway' AND status = 'pending'
     AND created_at > now() - interval '1 hour';
  IF v_recent >= 5 THEN
    RAISE EXCEPTION 'Too many open checkouts. Finish or wait for the last one, then try again.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.payments (user_id, currency, status, payment_method, plan_id, discount_code)
  VALUES (v_uid, 'GHS', 'pending', 'ogateway', p_plan_id, NULLIF(btrim(p_discount_code), ''))
  RETURNING * INTO v_row;

  IF v_row.amount_usd IS NULL OR v_row.amount_usd <= 0 THEN
    RAISE EXCEPTION 'This plan could not be priced' USING ERRCODE = '22023';
  END IF;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.create_gateway_payment(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_gateway_payment(uuid, text) TO authenticated;

-- A checkout that failed or was abandoned is closed without the "payment rejected" email
-- (the customer never completed a payment; nothing was rejected).
CREATE OR REPLACE FUNCTION public.close_gateway_payment(p_payment_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM set_config('app.suppress_payment_dispatch', 'on', true);
  UPDATE public.payments
     SET status = 'rejected', updated_at = now()
   WHERE id = p_payment_id AND status = 'pending' AND payment_method = 'ogateway';
END;
$$;
REVOKE ALL ON FUNCTION public.close_gateway_payment(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_gateway_payment(uuid) TO service_role;

-- Relay for OGateway calls through the database's fixed outbound address, for use if OGateway
-- only accepts allow-listed IPs (edge functions have no fixed address). pg_net sends after the
-- queuing transaction commits, so it's two calls: queue, then read.
CREATE OR REPLACE FUNCTION public.og_http_queue(p_method text, p_url text, p_auth text, p_body jsonb DEFAULT NULL)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net
AS $$
BEGIN
  IF p_url NOT LIKE 'https://api.ogateway.io/%' THEN
    RAISE EXCEPTION 'og_http_queue only calls api.ogateway.io';
  END IF;
  IF upper(p_method) = 'GET' THEN
    RETURN net.http_get(url := p_url, headers := jsonb_build_object('Authorization', p_auth), timeout_milliseconds := 20000);
  END IF;
  RETURN net.http_post(url := p_url, body := COALESCE(p_body, '{}'::jsonb),
    headers := jsonb_build_object('Authorization', p_auth, 'Content-Type', 'application/json'),
    timeout_milliseconds := 20000);
END;
$$;
REVOKE ALL ON FUNCTION public.og_http_queue(text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.og_http_queue(text, text, text, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.og_http_result(p_id bigint)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, net
AS $$
  SELECT jsonb_build_object('status', r.status_code, 'body', r.content, 'error', r.error_msg)
    FROM net._http_response r WHERE r.id = p_id;
$$;
REVOKE ALL ON FUNCTION public.og_http_result(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.og_http_result(bigint) TO service_role;
