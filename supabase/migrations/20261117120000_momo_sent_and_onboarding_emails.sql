-- Two conversion fixes (2026-11-17), from the prod funnel review:
--   * ~80% of Mobile Money trial checkouts were abandoned before the customer sent proof, mostly
--     at "paste your transaction ID". Customers can now say "I've sent it" with the number they
--     paid from (the ID becomes optional), and their purchase goes straight to admin review.
--   * 77% of buyers buy within an hour of signing up and almost none after a week, but nobody
--     heard from us after signup. New accounts now get a welcome email, and one reminder if they
--     start a checkout and don't finish it. Only accounts created after this migration are emailed.

-- ============================================================================ Mobile Money "I've sent it"

ALTER TABLE public.trial_purchases
  ADD COLUMN IF NOT EXISTS momo_sender_phone text,
  ADD COLUMN IF NOT EXISTS momo_sender_name text,
  ADD COLUMN IF NOT EXISTS customer_marked_sent_at timestamptz;

-- The customer has sent the Mobile Money transfer. Records the number (and name) it came from so
-- an admin can match it on the MoMo statement, and puts the purchase in review: rows flagged
-- needs_admin_review are never auto-failed by reconcile-trial-purchases. A purchase that already
-- expired (they paid late) is reopened, up to 72 hours after it was started.
CREATE OR REPLACE FUNCTION public.trial_momo_mark_sent(p_purchase_id uuid, p_sender_phone text, p_sender_name text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_p public.trial_purchases%ROWTYPE;
  v_phone text := regexp_replace(COALESCE(p_sender_phone, ''), '[[:space:]().-]', '', 'g');
  v_name text := NULLIF(left(btrim(COALESCE(p_sender_name, '')), 80), '');
  v_first boolean;
  v_email text;
  v_service_key text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in required' USING ERRCODE = '42501';
  END IF;
  IF v_phone !~ '^\+?[0-9]{9,15}$' THEN
    RAISE EXCEPTION 'Enter the Mobile Money number you paid from' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_p FROM public.trial_purchases WHERE id = p_purchase_id AND user_id = v_uid FOR UPDATE;
  IF NOT FOUND OR v_p.payment_method <> 'momo_manual' THEN
    RAISE EXCEPTION 'Purchase not found' USING ERRCODE = '22023';
  END IF;
  IF v_p.status = 'confirmed' THEN
    RETURN jsonb_build_object('ok', true, 'status', 'confirmed');
  END IF;
  IF v_p.status NOT IN ('pending', 'failed') OR v_p.created_at < now() - interval '72 hours' THEN
    RAISE EXCEPTION 'This purchase has closed. Start a new trial, or message support if you already paid.' USING ERRCODE = '22023';
  END IF;
  v_first := v_p.customer_marked_sent_at IS NULL;
  UPDATE public.trial_purchases
     SET momo_sender_phone = v_phone,
         momo_sender_name = v_name,
         customer_marked_sent_at = COALESCE(customer_marked_sent_at, now()),
         status = 'pending',
         needs_admin_review = true,
         updated_at = now()
   WHERE id = v_p.id;

  IF v_first THEN
    SELECT email INTO v_email FROM public.profiles WHERE user_id = v_uid;
    PERFORM public.app_notify(ur.user_id, 'payment', 'admin_trial_momo_sent', 'Mobile Money trial to confirm',
            'GHS ' || COALESCE(v_p.amount_local::text, '150') || ' from ' || v_phone || COALESCE(' (' || v_name || ')', '')
              || ' • ' || COALESCE(v_email, v_uid::text),
            '/admin', 'warning', 'trial_purchase', v_p.id, v_uid, '{}'::jsonb)
       FROM public.user_roles ur WHERE ur.role IN ('admin'::app_role, 'sec_admin'::app_role);
    BEGIN
      SELECT decrypted_secret INTO v_service_key FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key' LIMIT 1;
      IF v_service_key IS NOT NULL THEN
        PERFORM net.http_post(
          url := 'https://bbxahisheugfryyxfidg.supabase.co/functions/v1/send-admin-push',
          headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_service_key),
          body := jsonb_build_object(
            'event', 'trial_momo_manual_review',
            'title', 'Mobile Money trial: customer says it''s sent',
            'body', 'GHS ' || COALESCE(v_p.amount_local::text, '150') || ' from ' || v_phone || COALESCE(' (' || v_name || ')', '')
                    || ' • ' || COALESCE(v_email, 'user'),
            'url', '/admin',
            'tag', 'trial-momo-' || v_p.id));
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'trial_momo_mark_sent: admin push failed: %', SQLERRM;
    END;
  END IF;
  RETURN jsonb_build_object('ok', true, 'status', 'pending');
END;
$$;
REVOKE ALL ON FUNCTION public.trial_momo_mark_sent(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.trial_momo_mark_sent(uuid, text, text) TO authenticated;

-- ============================================================================ onboarding emails

CREATE TABLE IF NOT EXISTS public.onboarding_email_config (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled boolean NOT NULL DEFAULT true,
  -- only accounts created after this are emailed, so the existing ~2,300 users aren't
  starts_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.onboarding_email_config (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- One row per email sent, so each kind goes out at most once per account.
CREATE TABLE IF NOT EXISTS public.onboarding_emails (
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('welcome', 'checkout_reminder')),
  variant text,
  sent_at timestamptz NOT NULL DEFAULT now(),
  request_id bigint,
  PRIMARY KEY (user_id, kind)
);

ALTER TABLE public.onboarding_email_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_emails ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins read onboarding email config" ON public.onboarding_email_config FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Admins read onboarding emails" ON public.onboarding_emails FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

-- Email body in the admin-broadcast template's block format (it takes a subject, paragraphs,
-- lists and a button), so no email function needs redeploying.
CREATE OR REPLACE FUNCTION public._ob_p(p_text text, p_bold boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('kind', 'paragraph', 'runs', jsonb_build_array(jsonb_build_object('text', p_text, 'bold', p_bold)));
$$;
CREATE OR REPLACE FUNCTION public._ob_list(p_items text[])
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('kind', 'list', 'items',
           (SELECT jsonb_agg(jsonb_build_array(jsonb_build_object('text', i))) FROM unnest(p_items) i));
$$;
CREATE OR REPLACE FUNCTION public._ob_h(p_text text)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('kind', 'heading', 'runs', jsonb_build_array(jsonb_build_object('text', p_text)));
$$;

CREATE OR REPLACE FUNCTION public._onboarding_email_payload(p_kind text, p_variant text, p_display_name text)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_kind = 'welcome' THEN jsonb_build_object(
      'displayName', p_display_name,
      'subject', 'Welcome to Elite Swap: become any character, live',
      'blocks', jsonb_build_array(
        public._ob_p('Thanks for joining. Upload one photo, and your webcam brings it to life in real time, ready to stream into OBS, TikTok Live, YouTube, Twitch or a video call.'),
        public._ob_h('See it live in a few minutes'),
        public._ob_list(ARRAY[
          'Open your dashboard and tap Start Trial: 4 minutes of studio time for $10 (GHS 150).',
          'Pay by Mobile Money or USDT. With Mobile Money, just tell us the number you paid from.',
          'Upload a clear, front-facing photo and press Connect.']),
        public._ob_p('Professional and Enterprise add Elite AI Background: any scene behind your character, no green screen.'),
        jsonb_build_object('kind', 'paragraph', 'runs', jsonb_build_array(
          jsonb_build_object('text', 'Questions? Reply to this email, or message us on '),
          jsonb_build_object('text', 'WhatsApp', 'href', 'https://wa.me/233502657294'),
          jsonb_build_object('text', ' or '),
          jsonb_build_object('text', 'Telegram', 'href', 'https://t.me/elitetoolz'),
          jsonb_build_object('text', '; a real person answers.')))),
      'ctaLabel', 'Start my 4-minute trial',
      'ctaUrl', 'https://eliteswap.online/dashboard?start_trial=1')
    WHEN p_kind = 'checkout_reminder' AND p_variant = 'trial' THEN jsonb_build_object(
      'displayName', p_display_name,
      'subject', 'Your Elite Swap trial is waiting',
      'blocks', jsonb_build_array(
        public._ob_p('You started the $10 trial, but we haven''t received your payment yet. If something got in the way, finishing takes about a minute:'),
        public._ob_list(ARRAY[
          'Tap the button below and choose Mobile Money (GHS 150) or USDT.',
          'Mobile Money: send the amount shown, then tap "I''ve sent it" and enter the number you paid from. No transaction ID needed.',
          'We confirm it, usually within the hour, and your 4 minutes appear on your dashboard.']),
        public._ob_p('Already paid? Use the same button and tell us; we''ll match your payment.'),
        jsonb_build_object('kind', 'paragraph', 'runs', jsonb_build_array(
          jsonb_build_object('text', 'Stuck on anything? Reply to this email, or message us on '),
          jsonb_build_object('text', 'WhatsApp', 'href', 'https://wa.me/233502657294'),
          jsonb_build_object('text', ' or '),
          jsonb_build_object('text', 'Telegram', 'href', 'https://t.me/elitetoolz'),
          jsonb_build_object('text', '; a real person answers.')))),
      'ctaLabel', 'Finish my trial',
      'ctaUrl', 'https://eliteswap.online/dashboard?start_trial=1')
    ELSE jsonb_build_object(
      'displayName', p_display_name,
      'subject', 'Finish getting your Elite Swap plan',
      'blocks', jsonb_build_array(
        public._ob_p('You picked a plan but didn''t finish checking out. It''s still there whenever you''re ready.'),
        public._ob_list(ARRAY[
          'Paying in crypto for the first time? Reply to this email and we''ll walk you through it.',
          'Want to try it first? The 4-minute trial is $10, and you can pay by Mobile Money.',
          'Your minutes never expire, and the timer pauses whenever you disconnect.']),
        jsonb_build_object('kind', 'paragraph', 'runs', jsonb_build_array(
          jsonb_build_object('text', 'Questions about plans? Reply here, or message us on '),
          jsonb_build_object('text', 'WhatsApp', 'href', 'https://wa.me/233502657294'),
          jsonb_build_object('text', ' or '),
          jsonb_build_object('text', 'Telegram', 'href', 'https://t.me/elitetoolz'),
          jsonb_build_object('text', '; a real person answers.')))),
      'ctaLabel', 'Back to my dashboard',
      'ctaUrl', 'https://eliteswap.online/dashboard')
  END;
$$;

-- Runs every 10 minutes (cron). Picks accounts due an email, records them first (so a slow or
-- failed send is never retried into a duplicate), then asks send-transactional-email to send,
-- which also handles unsubscribes and the suppression list.
CREATE OR REPLACE FUNCTION public.onboarding_email_tick()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cfg public.onboarding_email_config%ROWTYPE;
  v_key text;
  v_sent integer := 0;
  r record;
  v_req bigint;
BEGIN
  SELECT * INTO v_cfg FROM public.onboarding_email_config WHERE id;
  IF NOT FOUND OR NOT v_cfg.enabled THEN
    RETURN 0;
  END IF;
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key' LIMIT 1;
  IF v_key IS NULL THEN
    RAISE WARNING 'onboarding_email_tick: no service key in vault';
    RETURN 0;
  END IF;

  FOR r IN
    WITH base AS (
      SELECT u.id, u.email, u.created_at, u.email_confirmed_at, p.display_name, p.payment_funnel_stage, p.payment_funnel_updated_at
        FROM auth.users u
        JOIN public.profiles p ON p.user_id = u.id
       WHERE u.created_at >= v_cfg.starts_at
         AND u.created_at > now() - interval '3 days'
         AND u.email IS NOT NULL
         AND u.email_confirmed_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = u.id)
         AND NOT EXISTS (SELECT 1 FROM public.payments x WHERE x.user_id = u.id AND x.status = 'confirmed')
         AND NOT EXISTS (SELECT 1 FROM public.trial_purchases t WHERE t.user_id = u.id AND t.status = 'confirmed')
         AND NOT EXISTS (SELECT 1 FROM public.account_deletion_requests d WHERE d.user_id = u.id AND d.cancelled_at IS NULL)
    ),
    due AS (
      -- welcome: a couple of minutes after the email is confirmed (Google sign-ups: at once)
      SELECT b.id, b.email, b.display_name, 'welcome'::text AS kind, NULL::text AS variant
        FROM base b
       WHERE b.email_confirmed_at <= now() - interval '2 minutes'
         AND NOT EXISTS (SELECT 1 FROM public.onboarding_emails e WHERE e.user_id = b.id AND e.kind = 'welcome')
      UNION ALL
      -- reminder: a trial checkout opened 45 min - 20 h ago with no payment or proof since
      SELECT b.id, b.email, b.display_name, 'checkout_reminder', 'trial'
        FROM base b
       WHERE EXISTS (SELECT 1 FROM public.trial_purchases t
                      WHERE t.user_id = b.id
                        AND t.created_at BETWEEN now() - interval '20 hours' AND now() - interval '45 minutes')
         AND NOT EXISTS (SELECT 1 FROM public.trial_purchases t
                          WHERE t.user_id = b.id
                            AND (t.provider_reference IS NOT NULL OR t.momo_sender_phone IS NOT NULL
                                 OR t.created_at > now() - interval '45 minutes'))
         AND NOT EXISTS (SELECT 1 FROM public.onboarding_emails e WHERE e.user_id = b.id AND e.kind = 'checkout_reminder')
      UNION ALL
      -- reminder: reached the plan payment screen 45 min - 20 h ago, never submitted a payment
      SELECT b.id, b.email, b.display_name, 'checkout_reminder', 'plan'
        FROM base b
       WHERE b.payment_funnel_stage BETWEEN 2 AND 5
         AND b.payment_funnel_updated_at BETWEEN now() - interval '20 hours' AND now() - interval '45 minutes'
         AND NOT EXISTS (SELECT 1 FROM public.payments x WHERE x.user_id = b.id)
         AND NOT EXISTS (SELECT 1 FROM public.trial_purchases t WHERE t.user_id = b.id)
         AND NOT EXISTS (SELECT 1 FROM public.onboarding_emails e WHERE e.user_id = b.id AND e.kind = 'checkout_reminder')
    )
    SELECT DISTINCT ON (id, kind) * FROM due ORDER BY id, kind, variant
    LIMIT 100
  LOOP
    INSERT INTO public.onboarding_emails (user_id, kind, variant) VALUES (r.id, r.kind, r.variant)
    ON CONFLICT (user_id, kind) DO NOTHING;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    SELECT net.http_post(
      url := 'https://bbxahisheugfryyxfidg.supabase.co/functions/v1/send-transactional-email',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
      body := jsonb_build_object(
        'templateName', 'admin-broadcast',
        'recipientEmail', r.email,
        'idempotencyKey', 'onboarding-' || r.kind || '-' || r.id,
        'templateData', public._onboarding_email_payload(r.kind, r.variant, r.display_name))
    ) INTO v_req;
    UPDATE public.onboarding_emails SET request_id = v_req WHERE user_id = r.id AND kind = r.kind;
    v_sent := v_sent + 1;
  END LOOP;
  RETURN v_sent;
END;
$$;
REVOKE ALL ON FUNCTION public.onboarding_email_tick() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'onboarding-emails';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;
  PERFORM cron.schedule('onboarding-emails', '*/10 * * * *', 'SELECT public.onboarding_email_tick()');
END $$;
