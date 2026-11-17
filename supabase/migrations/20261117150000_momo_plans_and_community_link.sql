-- Mobile Money for full plans, and an admin-editable WhatsApp community link (2026-11-17).
--
-- Plans were crypto-only. Customers can now pay any plan by Mobile Money with the same
-- "I've sent it" flow as the $10 trial. The cedi amount is worked out on the server, never in
-- the browser: the plan's real price (sale or valid code included, via quote_plan_price) times
-- today's USD->GHS rate, rounded up to a whole cedi, and locked in a quote for that customer.
-- The rate comes from open.er-api.com (the same source the site displays and the OGateway
-- checkout uses), cached in fx_rates by a cron job because a database function can't wait on an
-- HTTP call. Submissions become ordinary pending payments (payment_method 'momo_manual') that an
-- admin approves in Payments, which issues the key exactly as for crypto.

-- ============================================================================ site settings

CREATE TABLE IF NOT EXISTS public.site_settings (
  key text PRIMARY KEY,
  value text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
ALTER TABLE public.site_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins read site settings" ON public.site_settings FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

-- Mobile Money receiving account: the same details create-trial-purchase shows for the trial.
INSERT INTO public.site_settings (key, value) VALUES
  ('momo_number', '0502657294'),
  ('momo_network', 'Telecel Cash'),
  ('momo_name', 'Linda Brakoh-Kwakyi'),
  ('whatsapp_group_url', '')
ON CONFLICT (key) DO NOTHING;

-- Public links shown on the site (empty = hidden).
CREATE OR REPLACE FUNCTION public.get_site_links()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object('whatsapp_group_url', COALESCE((SELECT value FROM public.site_settings WHERE key = 'whatsapp_group_url'), ''));
$$;
REVOKE ALL ON FUNCTION public.get_site_links() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_site_links() TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_set_site_link(p_key text, p_value text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_value text := btrim(COALESCE(p_value, ''));
  v_before text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'Admins only' USING ERRCODE = '42501';
  END IF;
  IF p_key <> 'whatsapp_group_url' THEN
    RAISE EXCEPTION 'Unknown setting' USING ERRCODE = '22023';
  END IF;
  IF v_value <> '' AND v_value !~ '^https://chat\.whatsapp\.com/[A-Za-z0-9]+' THEN
    RAISE EXCEPTION 'Paste a WhatsApp group invite link (https://chat.whatsapp.com/...)' USING ERRCODE = '22023';
  END IF;
  SELECT value INTO v_before FROM public.site_settings WHERE key = p_key;
  INSERT INTO public.site_settings (key, value, updated_at, updated_by) VALUES (p_key, v_value, now(), auth.uid())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = auth.uid();
  PERFORM public.log_admin_action('site_link_set', 'site_setting', p_key,
    jsonb_build_object('value', v_before), jsonb_build_object('value', v_value));
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_site_link(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_site_link(text, text) TO authenticated;

-- ============================================================================ USD -> GHS rate cache

CREATE TABLE IF NOT EXISTS public.fx_rates (
  currency text PRIMARY KEY,
  per_usd numeric NOT NULL CHECK (per_usd > 0),
  source text NOT NULL,
  source_updated_at timestamptz,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.fx_rate_requests (
  request_id bigint PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
ALTER TABLE public.fx_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fx_rate_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins read fx rates" ON public.fx_rates FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

-- Each run stores the reply to the previous run's request, then asks again. pg_net replies arrive
-- asynchronously, so a fresh rate is at most two runs old.
CREATE OR REPLACE FUNCTION public.fx_refresh_tick()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v jsonb;
  v_rate numeric;
  v_req bigint;
  v_note text := 'no reply yet';
BEGIN
  FOR r IN
    SELECT q.request_id, h.status_code, h.content
      FROM public.fx_rate_requests q
      JOIN net._http_response h ON h.id = q.request_id
     WHERE q.processed_at IS NULL
     ORDER BY q.request_id
  LOOP
    BEGIN
      v := r.content::jsonb;
      v_rate := (v->'rates'->>'GHS')::numeric;
      IF r.status_code = 200 AND v->>'result' = 'success' AND v_rate BETWEEN 5 AND 50 THEN
        INSERT INTO public.fx_rates (currency, per_usd, source, source_updated_at, fetched_at)
        VALUES ('GHS', v_rate, 'open.er-api.com', to_timestamp((v->>'time_last_update_unix')::bigint), now())
        ON CONFLICT (currency) DO UPDATE
          SET per_usd = EXCLUDED.per_usd, source = EXCLUDED.source,
              source_updated_at = EXCLUDED.source_updated_at, fetched_at = EXCLUDED.fetched_at;
        v_note := 'GHS ' || v_rate;
      ELSE
        v_note := 'bad reply (' || COALESCE(r.status_code::text, '?') || ')';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_note := 'unreadable reply';
    END;
    UPDATE public.fx_rate_requests SET processed_at = now() WHERE request_id = r.request_id;
  END LOOP;
  DELETE FROM public.fx_rate_requests WHERE created_at < now() - interval '1 day';
  SELECT net.http_get(url := 'https://open.er-api.com/v6/latest/USD') INTO v_req;
  INSERT INTO public.fx_rate_requests (request_id) VALUES (v_req) ON CONFLICT DO NOTHING;
  RETURN v_note;
END;
$$;
REVOKE ALL ON FUNCTION public.fx_refresh_tick() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'fx-refresh';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;
  PERFORM cron.schedule('fx-refresh', '*/15 * * * *', 'SELECT public.fx_refresh_tick()');
END $$;

-- ============================================================================ Mobile Money for plans

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS momo_sender_phone text,
  ADD COLUMN IF NOT EXISTS momo_sender_name text,
  ADD COLUMN IF NOT EXISTS customer_marked_sent_at timestamptz;

-- A cedi price, locked for one customer when they open Mobile Money on a plan.
CREATE TABLE IF NOT EXISTS public.momo_plan_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  plan_id uuid NOT NULL REFERENCES public.pricing_plans(id),
  billing_period text NOT NULL CHECK (billing_period IN ('monthly', 'annual')),
  discount_code text,
  amount_usd numeric NOT NULL,
  fx_rate numeric NOT NULL,
  amount_ghs numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  payment_id uuid
);
CREATE INDEX IF NOT EXISTS idx_momo_plan_quotes_user ON public.momo_plan_quotes(user_id, created_at DESC);
ALTER TABLE public.momo_plan_quotes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins read momo quotes" ON public.momo_plan_quotes FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE OR REPLACE FUNCTION public.quote_momo_plan(p_plan_id uuid, p_billing_period text DEFAULT 'monthly', p_discount_code text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_period text := CASE WHEN p_billing_period = 'annual' THEN 'annual' ELSE 'monthly' END;
  v_plan public.pricing_plans%ROWTYPE;
  q record;
  v_fx public.fx_rates%ROWTYPE;
  v_ghs numeric;
  v_id uuid;
  v_seller text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in required' USING ERRCODE = '42501';
  END IF;
  SELECT r.display_name INTO v_seller
    FROM public.reseller_customers c JOIN public.resellers r ON r.id = c.reseller_id
   WHERE c.user_id = v_uid AND r.is_active;
  IF v_seller IS NOT NULL THEN
    RAISE EXCEPTION 'Your plans are sold by %. Contact them to buy minutes.', v_seller USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM public.momo_plan_quotes WHERE user_id = v_uid AND created_at > now() - interval '1 hour') >= 30 THEN
    RAISE EXCEPTION 'Too many attempts. Wait a few minutes and try again.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_plan FROM public.pricing_plans WHERE id = p_plan_id AND is_active AND price_usd > 0;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Choose a plan to pay for' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO q FROM public.quote_plan_price(p_plan_id, v_period, NULLIF(btrim(p_discount_code), ''), v_uid);
  IF NOT FOUND OR q.list_usd IS NULL OR q.list_usd <= 0 OR q.final_usd IS NULL OR q.final_usd <= 0 THEN
    RAISE EXCEPTION 'This plan can''t be paid by Mobile Money%', CASE WHEN v_period = 'annual' THEN ' annually' ELSE '' END USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_fx FROM public.fx_rates WHERE currency = 'GHS';
  IF NOT FOUND OR v_fx.fetched_at < now() - interval '48 hours' THEN
    RAISE EXCEPTION 'We couldn''t get today''s cedi rate. Try again in a few minutes, or pay with crypto.' USING ERRCODE = '22023';
  END IF;
  v_ghs := ceil(q.final_usd * v_fx.per_usd);
  INSERT INTO public.momo_plan_quotes (user_id, plan_id, billing_period, discount_code, amount_usd, fx_rate, amount_ghs)
  VALUES (v_uid, p_plan_id, v_period, q.code, q.final_usd, v_fx.per_usd, v_ghs)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object(
    'quote_id', v_id,
    'plan_name', v_plan.name,
    'billing_period', v_period,
    'amount_usd', q.final_usd,
    'list_usd', q.list_usd,
    'discount_percent', q.applied_percent,
    'discount_code', q.code,
    'fx_rate', v_fx.per_usd,
    'rate_date', COALESCE(v_fx.source_updated_at, v_fx.fetched_at),
    'amount_ghs', v_ghs,
    'momo_number', (SELECT value FROM public.site_settings WHERE key = 'momo_number'),
    'momo_network', (SELECT value FROM public.site_settings WHERE key = 'momo_network'),
    'momo_name', (SELECT value FROM public.site_settings WHERE key = 'momo_name'));
END;
$$;
REVOKE ALL ON FUNCTION public.quote_momo_plan(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.quote_momo_plan(uuid, text, text) TO authenticated;

-- "I've sent it" for a plan: becomes a pending payment for admin review, at the locked price.
-- Calling it again for the same quote updates the details (fixing a typo, adding the ID later).
CREATE OR REPLACE FUNCTION public.submit_momo_plan_payment(p_quote_id uuid, p_sender_phone text DEFAULT NULL, p_sender_name text DEFAULT NULL, p_reference text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_q public.momo_plan_quotes%ROWTYPE;
  v_phone text := NULLIF(regexp_replace(COALESCE(p_sender_phone, ''), '[[:space:]().-]', '', 'g'), '');
  v_name text := NULLIF(left(btrim(COALESCE(p_sender_name, '')), 80), '');
  v_ref text := NULLIF(left(btrim(COALESCE(p_reference, '')), 120), '');
  v_payment_id uuid;
  v_email text;
  v_key text;
  v_plan_name text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in required' USING ERRCODE = '42501';
  END IF;
  IF v_phone IS NOT NULL AND v_phone !~ '^\+?[0-9]{9,15}$' THEN
    RAISE EXCEPTION 'Enter the Mobile Money number you paid from' USING ERRCODE = '22023';
  END IF;
  IF v_phone IS NULL AND (v_ref IS NULL OR length(v_ref) < 6) THEN
    RAISE EXCEPTION 'Enter the number you paid from, or the transaction ID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_q FROM public.momo_plan_quotes WHERE id = p_quote_id AND user_id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found. Open Mobile Money on the plan again.' USING ERRCODE = '22023';
  END IF;

  IF v_q.payment_id IS NOT NULL THEN
    UPDATE public.payments
       SET momo_sender_phone = COALESCE(v_phone, momo_sender_phone),
           momo_sender_name = COALESCE(v_name, momo_sender_name),
           provider_reference = COALESCE(provider_reference, v_ref)
     WHERE id = v_q.payment_id AND user_id = v_uid AND status = 'pending';
    RETURN jsonb_build_object('ok', true, 'payment_id', v_q.payment_id);
  END IF;

  IF v_q.created_at < now() - interval '72 hours' THEN
    RAISE EXCEPTION 'This price has expired. Open Mobile Money on the plan again for today''s amount.' USING ERRCODE = '22023';
  END IF;
  IF v_ref IS NOT NULL AND EXISTS (SELECT 1 FROM public.payments WHERE provider_reference = v_ref) THEN
    RAISE EXCEPTION 'That transaction ID was already submitted' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.payments (user_id, currency, status, payment_method, plan_id, billing_period, discount_code,
                               amount_local, fx_rate, provider_reference, momo_sender_phone, momo_sender_name, customer_marked_sent_at)
  VALUES (v_uid, 'GHS', 'pending', 'momo_manual', v_q.plan_id, v_q.billing_period, v_q.discount_code,
          v_q.amount_ghs, v_q.fx_rate, v_ref, v_phone, v_name, now())
  RETURNING id INTO v_payment_id;
  -- keep the US-dollar amount they were quoted (the insert triggers re-price at today's sale/code)
  UPDATE public.payments SET amount_usd = v_q.amount_usd
   WHERE id = v_payment_id AND amount_usd IS DISTINCT FROM v_q.amount_usd;
  UPDATE public.momo_plan_quotes SET payment_id = v_payment_id WHERE id = v_q.id;

  SELECT email INTO v_email FROM public.profiles WHERE user_id = v_uid;
  SELECT name INTO v_plan_name FROM public.pricing_plans WHERE id = v_q.plan_id;
  BEGIN
    SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key' LIMIT 1;
    IF v_key IS NOT NULL THEN
      PERFORM net.http_post(
        url := 'https://bbxahisheugfryyxfidg.supabase.co/functions/v1/send-admin-push',
        headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
        body := jsonb_build_object(
          'event', 'pending_review',
          'title', 'Mobile Money plan payment to confirm',
          'body', 'GHS ' || v_q.amount_ghs || ' for ' || COALESCE(v_plan_name, 'a plan')
                  || CASE WHEN v_q.billing_period = 'annual' THEN ' (annual)' ELSE '' END
                  || COALESCE(' from ' || v_phone, '') || COALESCE(' (' || v_name || ')', '')
                  || COALESCE(' • ref ' || v_ref, '') || ' • ' || COALESCE(v_email, 'user'),
          'url', '/admin',
          'tag', 'momo-plan-' || v_payment_id));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'submit_momo_plan_payment: admin push failed: %', SQLERRM;
  END;
  RETURN jsonb_build_object('ok', true, 'payment_id', v_payment_id);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_momo_plan_payment(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_momo_plan_payment(uuid, text, text, text) TO authenticated;

-- ============================================================================ welcome email: plans by MoMo + community link

CREATE OR REPLACE FUNCTION public._onboarding_email_payload(p_kind text, p_variant text, p_display_name text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group text := COALESCE((SELECT value FROM public.site_settings WHERE key = 'whatsapp_group_url'), '');
  v_contact jsonb := jsonb_build_object('kind', 'paragraph', 'runs', jsonb_build_array(
    jsonb_build_object('text', 'Questions? Reply to this email, or message us on '),
    jsonb_build_object('text', 'WhatsApp', 'href', 'https://wa.me/233502657294'),
    jsonb_build_object('text', ' or '),
    jsonb_build_object('text', 'Telegram', 'href', 'https://t.me/elitetoolz'),
    jsonb_build_object('text', '; a real person answers.')));
  v_community jsonb := CASE WHEN v_group <> '' THEN jsonb_build_object('kind', 'paragraph', 'runs', jsonb_build_array(
    jsonb_build_object('text', 'Join our '),
    jsonb_build_object('text', 'WhatsApp community', 'href', v_group, 'bold', true),
    jsonb_build_object('text', ' for early news, members-only offers and tips from other creators.'))) END;
  v_blocks jsonb;
BEGIN
  IF p_kind = 'welcome' THEN
    v_blocks := jsonb_build_array(
      public._ob_p('Thanks for joining. Upload one photo, and your webcam brings it to life in real time, ready to stream into OBS, TikTok Live, YouTube, Twitch or a video call.'),
      public._ob_h('See it live in a few minutes'),
      public._ob_list(ARRAY[
        'Open your dashboard and tap Start Trial: 4 minutes of studio time for $10 (GHS 150).',
        'Pay by Mobile Money or USDT. With Mobile Money, just tell us the number you paid from.',
        'Upload a clear, front-facing photo and press Connect.']),
      public._ob_p('Ready for more? Every plan can now be paid by Mobile Money too, in cedis at today''s rate. Professional and Enterprise add Elite AI Background: any scene behind your character, no green screen.'));
    IF v_community IS NOT NULL THEN v_blocks := v_blocks || jsonb_build_array(v_community); END IF;
    RETURN jsonb_build_object('displayName', p_display_name, 'subject', 'Welcome to Elite Swap: become any character, live',
      'blocks', v_blocks || jsonb_build_array(v_contact),
      'ctaLabel', 'Start my 4-minute trial', 'ctaUrl', 'https://eliteswap.online/dashboard?start_trial=1');
  ELSIF p_kind = 'checkout_reminder' AND p_variant = 'trial' THEN
    RETURN jsonb_build_object('displayName', p_display_name, 'subject', 'Your Elite Swap trial is waiting',
      'blocks', jsonb_build_array(
        public._ob_p('You started the $10 trial, but we haven''t received your payment yet. If something got in the way, finishing takes about a minute:'),
        public._ob_list(ARRAY[
          'Tap the button below and choose Mobile Money (GHS 150) or USDT.',
          'Mobile Money: send the amount shown, then tap "I''ve sent it" and enter the number you paid from. No transaction ID needed.',
          'We confirm it, usually within the hour, and your 4 minutes appear on your dashboard.']),
        public._ob_p('Already paid? Use the same button and tell us; we''ll match your payment.'),
        v_contact),
      'ctaLabel', 'Finish my trial', 'ctaUrl', 'https://eliteswap.online/dashboard?start_trial=1');
  ELSE
    RETURN jsonb_build_object('displayName', p_display_name, 'subject', 'Finish getting your Elite Swap plan',
      'blocks', jsonb_build_array(
        public._ob_p('You picked a plan but didn''t finish checking out. It''s still there whenever you''re ready.'),
        public._ob_list(ARRAY[
          'No crypto? Pay any plan by Mobile Money, in cedis at today''s rate.',
          'Want to try it first? The 4-minute trial is $10, and you can pay by Mobile Money.',
          'Your minutes never expire, and the timer pauses whenever you disconnect.']),
        v_contact),
      'ctaLabel', 'Back to my dashboard', 'ctaUrl', 'https://eliteswap.online/dashboard');
  END IF;
END;
$$;
