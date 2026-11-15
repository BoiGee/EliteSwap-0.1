-- Reseller program.
--
-- A reseller sells Elite Swap plans to his own customers at his own prices. For every sale,
-- Elite Swap takes the plan's LIST price plus half of his markup; he keeps the other half.
-- Elite Swap's share is debited on the spot from his prepaid USD balance (topped up with crypto,
-- approved by an admin), so nothing is ever owed on credit.
--
--   his price $250, Professional list $210  ->  markup $40  ->  Elite Swap $230, reseller $20
--
-- Rules agreed with the business owner (2026-11-15):
--   * base = list price (pricing_plans.price_usd / price_usd_annual); sales and codes never apply;
--   * he is not a partner: no commission of any kind on his sales;
--   * his customers can't buy plans from Elite Swap directly while he is active
--     (the $10 trial is untouched and stays direct);
--   * he can void a sale within 24 hours if the key hasn't been used: his balance is refunded in
--     full and the key is switched off.
--
-- Each sale is recorded as a confirmed payments row (payment_method = 'reseller',
-- amount_usd = Elite Swap's share), so the existing key issuance, the Professional/Enterprise
-- Elite AI Background check (key -> payment -> plan), finance reports and paid-user stats all
-- work unchanged. Five existing payment functions get a one-line guard so that, for a sale
-- recorded by reseller_record_sale() (transaction-local flag app.reseller_sale = 'on'), they
-- don't re-price the row, refuse to issue the key to someone other than the caller, or alert the
-- primary admin that "someone else confirmed a payment". Nothing else about them changes.

-- ============================================================================ tables

CREATE TABLE IF NOT EXISTS public.resellers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{3,20}$'),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 2 AND 60),
  contact text CHECK (contact IS NULL OR length(contact) <= 120),
  balance_usd numeric NOT NULL DEFAULT 0 CHECK (balance_usd >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- price_usd is the approved price used for sales; proposed_price_usd waits for an admin.
CREATE TABLE IF NOT EXISTS public.reseller_prices (
  reseller_id uuid NOT NULL REFERENCES public.resellers(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES public.pricing_plans(id) ON DELETE CASCADE,
  billing_period text NOT NULL CHECK (billing_period IN ('monthly', 'annual')),
  price_usd numeric CHECK (price_usd > 0),
  proposed_price_usd numeric CHECK (proposed_price_usd > 0),
  proposed_at timestamptz,
  approved_at timestamptz,
  approved_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reseller_id, plan_id, billing_period)
);

CREATE TABLE IF NOT EXISTS public.reseller_customers (
  user_id uuid PRIMARY KEY,
  reseller_id uuid NOT NULL REFERENCES public.resellers(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('link', 'code', 'admin')),
  attached_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reseller_customers_reseller ON public.reseller_customers(reseller_id);

CREATE TABLE IF NOT EXISTS public.reseller_topups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_id uuid NOT NULL REFERENCES public.resellers(id) ON DELETE CASCADE,
  amount_usd numeric NOT NULL CHECK (amount_usd > 0),
  currency text NOT NULL CHECK (currency IN ('BTC', 'BNB', 'USDT-BEP20', 'USDT-TRC20')),
  tx_hash text NOT NULL UNIQUE CHECK (length(btrim(tx_hash)) BETWEEN 10 AND 200),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  credited_usd numeric CHECK (credited_usd > 0),
  review_note text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reseller_topups_reseller ON public.reseller_topups(reseller_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.reseller_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_id uuid NOT NULL REFERENCES public.resellers(id) ON DELETE RESTRICT,
  customer_user_id uuid NOT NULL,
  plan_id uuid NOT NULL REFERENCES public.pricing_plans(id),
  plan_name text NOT NULL,
  billing_period text NOT NULL CHECK (billing_period IN ('monthly', 'annual')),
  list_price_usd numeric NOT NULL,
  reseller_price_usd numeric NOT NULL,
  platform_share_usd numeric NOT NULL,
  reseller_share_usd numeric NOT NULL,
  payment_id uuid,            -- the confirmed payments row behind the key (removed if voided)
  api_key_id uuid,
  key_ms bigint,              -- minutes on the key at sale time, to tell whether it's been used
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  void_reason text
);
CREATE INDEX IF NOT EXISTS idx_reseller_sales_reseller ON public.reseller_sales(reseller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reseller_sales_customer ON public.reseller_sales(customer_user_id);
CREATE INDEX IF NOT EXISTS idx_reseller_sales_payment ON public.reseller_sales(payment_id);

-- Every balance change, with the balance after it. Only written by _reseller_post().
CREATE TABLE IF NOT EXISTS public.reseller_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_id uuid NOT NULL REFERENCES public.resellers(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('topup', 'sale', 'void', 'adjustment')),
  amount_usd numeric NOT NULL CHECK (amount_usd <> 0),
  balance_after_usd numeric NOT NULL,
  topup_id uuid REFERENCES public.reseller_topups(id),
  sale_id uuid REFERENCES public.reseller_sales(id),
  note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reseller_ledger_reseller ON public.reseller_ledger(reseller_id, created_at DESC);

-- ============================================================================ row-level security
-- Reads only. Every write goes through the SECURITY DEFINER functions below.

ALTER TABLE public.resellers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reseller_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reseller_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reseller_topups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reseller_sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reseller_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read resellers" ON public.resellers FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Reseller reads own row" ON public.resellers FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Admins read reseller prices" ON public.reseller_prices FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Reseller reads own prices" ON public.reseller_prices FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.resellers r WHERE r.id = reseller_prices.reseller_id AND r.user_id = auth.uid()));

CREATE POLICY "Admins read reseller customers" ON public.reseller_customers FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Reseller reads own customers" ON public.reseller_customers FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.resellers r WHERE r.id = reseller_customers.reseller_id AND r.user_id = auth.uid()));
CREATE POLICY "Customer reads own link" ON public.reseller_customers FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Admins read reseller topups" ON public.reseller_topups FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Reseller reads own topups" ON public.reseller_topups FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.resellers r WHERE r.id = reseller_topups.reseller_id AND r.user_id = auth.uid()));

-- Customers don't get a policy here: the row shows the split. They see their own purchases
-- (price only) through my_reseller_purchases().
CREATE POLICY "Admins read reseller sales" ON public.reseller_sales FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Reseller reads own sales" ON public.reseller_sales FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.resellers r WHERE r.id = reseller_sales.reseller_id AND r.user_id = auth.uid()));

CREATE POLICY "Admins read reseller ledger" ON public.reseller_ledger FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Reseller reads own ledger" ON public.reseller_ledger FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.resellers r WHERE r.id = reseller_ledger.reseller_id AND r.user_id = auth.uid()));

-- ============================================================================ guards

-- Codes: upper-case, and never the same as a partner code (the dashboard's referral box tries
-- partner codes first, then reseller codes). Balance: only through the ledger.
CREATE OR REPLACE FUNCTION public.tg_resellers_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.code := upper(btrim(NEW.code));
  NEW.display_name := btrim(NEW.display_name);
  NEW.contact := NULLIF(btrim(NEW.contact), '');
  NEW.updated_at := now();
  IF (TG_OP = 'INSERT' OR NEW.code IS DISTINCT FROM OLD.code)
     AND EXISTS (SELECT 1 FROM public.partners p WHERE p.code = NEW.code) THEN
    RAISE EXCEPTION 'The code % is already used by a partner', NEW.code USING ERRCODE = '23505';
  END IF;
  IF COALESCE(current_setting('app.reseller_ledger', true), '') <> 'on' THEN
    IF TG_OP = 'INSERT' AND NEW.balance_usd <> 0 THEN
      RAISE EXCEPTION 'A reseller starts with a zero balance' USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.balance_usd IS DISTINCT FROM OLD.balance_usd THEN
      RAISE EXCEPTION 'Reseller balances change only through the ledger' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS resellers_guard ON public.resellers;
CREATE TRIGGER resellers_guard BEFORE INSERT OR UPDATE ON public.resellers
FOR EACH ROW EXECUTE FUNCTION public.tg_resellers_guard();

CREATE OR REPLACE FUNCTION public.tg_partners_code_not_reseller()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.resellers r WHERE r.code = upper(btrim(NEW.code))) THEN
    RAISE EXCEPTION 'The code % is already used by a reseller', upper(btrim(NEW.code)) USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS partners_code_not_reseller ON public.partners;
CREATE TRIGGER partners_code_not_reseller BEFORE INSERT OR UPDATE OF code ON public.partners
FOR EACH ROW EXECUTE FUNCTION public.tg_partners_code_not_reseller();

-- A reseller's customer can't also be a partner referral (that would pay commission on his sales).
CREATE OR REPLACE FUNCTION public.tg_partner_attr_not_reseller_customer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.reseller_customers c WHERE c.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'This account buys through a reseller, so it can''t use a referral code' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS partner_attr_not_reseller_customer ON public.partner_attributions;
CREATE TRIGGER partner_attr_not_reseller_customer BEFORE INSERT OR UPDATE OF user_id ON public.partner_attributions
FOR EACH ROW EXECUTE FUNCTION public.tg_partner_attr_not_reseller_customer();

-- Payments: 'reseller' rows only come from reseller_record_sale(); and while his reseller is
-- active, a customer can't open a plan payment with Elite Swap directly (crypto, card, MoMo or
-- an edge function acting for them). Admins / payment managers can still record one by hand.
CREATE OR REPLACE FUNCTION public.tg_payments_reseller_rules()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_seller record;
BEGIN
  IF COALESCE(current_setting('app.reseller_sale', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  IF NEW.payment_method = 'reseller' THEN
    RAISE EXCEPTION 'Reseller sales can only be recorded from the reseller console' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.plan_id IS NOT NULL THEN
    IF v_uid IS NOT NULL AND (public.has_role(v_uid, 'admin'::app_role) OR public.can_manage_payments(v_uid)) THEN
      RETURN NEW;
    END IF;
    SELECT r.display_name, r.contact INTO v_seller
      FROM public.reseller_customers c
      JOIN public.resellers r ON r.id = c.reseller_id
     WHERE c.user_id = NEW.user_id AND r.is_active;
    IF FOUND THEN
      RAISE EXCEPTION 'Your plans are sold by %. Contact them to buy minutes%.',
        v_seller.display_name,
        CASE WHEN v_seller.contact IS NOT NULL THEN ' (' || v_seller.contact || ')' ELSE '' END
        USING ERRCODE = '22023';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS payments_reseller_rules ON public.payments;
CREATE TRIGGER payments_reseller_rules BEFORE INSERT OR UPDATE OF payment_method ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.tg_payments_reseller_rules();

-- ============================================================================ existing payment functions
-- Each is its latest definition, unchanged except for the marked reseller line.

CREATE OR REPLACE FUNCTION public.payments_enforce_financials()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  q record;
BEGIN
  NEW.billing_period := CASE WHEN NEW.billing_period = 'annual' THEN 'annual' ELSE 'monthly' END;
  -- reseller sale: priced by reseller_record_sale() (list price + half the markup)
  IF COALESCE(current_setting('app.reseller_sale', true), '') = 'on' THEN RETURN NEW; END IF;
  IF auth.uid() IS NULL OR public.has_role(auth.uid(), 'admin'::app_role) OR public.can_manage_payments(auth.uid()) THEN
    RETURN NEW;
  END IF;
  IF NEW.plan_id IS NULL THEN
    NEW.amount_usd := NULL;
    NEW.discount_code := NULL;
    NEW.discount_amount_usd := NULL;
    NEW.promotion_id := NULL;
    NEW.commission_pct_snapshot := NULL;
    NEW.commission_base_usd_snapshot := NULL;
    RETURN NEW;
  END IF;
  SELECT * INTO q FROM public.quote_plan_price(NEW.plan_id, NEW.billing_period, NEW.discount_code, NEW.user_id);
  IF NOT FOUND THEN
    NEW.amount_usd := NULL;
    NEW.discount_code := NULL;
    NEW.discount_amount_usd := NULL;
    NEW.promotion_id := NULL;
    NEW.commission_pct_snapshot := NULL;
    NEW.commission_base_usd_snapshot := NULL;
    RETURN NEW;
  END IF;
  IF q.list_usd IS NULL THEN
    RAISE EXCEPTION 'Annual billing isn''t available for this plan.' USING ERRCODE = '22023';
  END IF;
  IF q.list_usd <= 0 THEN
    RAISE EXCEPTION 'This plan is priced on request. Message us from the chat button for a quote.' USING ERRCODE = '22023';
  END IF;
  NEW.amount_usd := q.final_usd;
  NEW.discount_code := q.code;
  NEW.discount_amount_usd := NULLIF(q.discount_usd, 0);
  NEW.promotion_id := q.promotion_id;
  NEW.commission_base_usd_snapshot := q.commission_base_usd;
  NEW.commission_pct_snapshot := NULL;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.payments_sanitize_client_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_is_priv boolean := false;
  v_plan_price numeric;
  v_pct integer;
  v_applies uuid[];
  v_expires timestamptz;
  v_active boolean;
BEGIN
  -- reseller sale: priced by reseller_record_sale()
  IF COALESCE(current_setting('app.reseller_sale', true), '') = 'on' THEN RETURN NEW; END IF;
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;
  v_is_priv := public.has_role(v_uid, 'admin'::app_role) OR public.can_manage_payments(v_uid);
  IF v_is_priv THEN
    RETURN NEW;
  END IF;
  NEW.commission_pct_snapshot := NULL;
  NEW.commission_base_usd_snapshot := NULL;
  IF NEW.plan_id IS NOT NULL THEN
    SELECT price_usd INTO v_plan_price
    FROM public.pricing_plans
    WHERE id = NEW.plan_id AND is_active = true;
    NEW.amount_usd := v_plan_price;
  ELSE
    NEW.amount_usd := NULL;
  END IF;
  NEW.discount_amount_usd := NULL;
  IF NEW.discount_code IS NOT NULL AND NEW.amount_usd IS NOT NULL THEN
    SELECT percent_off, applies_to_plan_ids, expires_at, is_active
      INTO v_pct, v_applies, v_expires, v_active
    FROM public.discount_codes
    WHERE lower(code) = lower(NEW.discount_code)
    LIMIT 1;
    IF v_active IS TRUE
       AND (v_expires IS NULL OR v_expires > now())
       AND (v_applies IS NULL OR array_length(v_applies,1) IS NULL OR NEW.plan_id = ANY(v_applies))
       AND v_pct IS NOT NULL THEN
      NEW.discount_amount_usd := round((NEW.amount_usd * v_pct / 100.0)::numeric, 2);
    ELSE
      NEW.discount_code := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.tg_payments_normalize_amounts()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = 'public' AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_is_admin BOOLEAN := false;
  v_plan_price NUMERIC;
  v_code RECORD;
  v_already_used INTEGER;
  v_valid BOOLEAN := false;
  v_discount NUMERIC := 0;
BEGIN
  -- reseller sale: priced by reseller_record_sale()
  IF COALESCE(current_setting('app.reseller_sale', true), '') = 'on' THEN RETURN NEW; END IF;
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF v_uid IS NOT NULL THEN
    v_is_admin := public.has_role('admin'::app_role);
  END IF;
  IF v_is_admin THEN
    RETURN NEW;
  END IF;
  IF NEW.plan_id IS NULL THEN
    NEW.amount_usd := NULL;
    NEW.discount_code := NULL;
    NEW.discount_amount_usd := NULL;
    RETURN NEW;
  END IF;
  SELECT price_usd INTO v_plan_price FROM public.pricing_plans
  WHERE id = NEW.plan_id AND is_active = true;
  IF v_plan_price IS NULL THEN
    NEW.amount_usd := NULL;
    NEW.discount_code := NULL;
    NEW.discount_amount_usd := NULL;
    RETURN NEW;
  END IF;
  IF NEW.discount_code IS NOT NULL AND length(trim(NEW.discount_code)) > 0 THEN
    SELECT * INTO v_code FROM public.discount_codes
    WHERE code = upper(trim(NEW.discount_code));
    IF FOUND
       AND v_code.is_active
       AND (v_code.expires_at IS NULL OR v_code.expires_at > now())
       AND (v_code.applies_to_plan_ids IS NULL
            OR array_length(v_code.applies_to_plan_ids, 1) IS NULL
            OR NEW.plan_id = ANY(v_code.applies_to_plan_ids))
    THEN
      IF v_code.redemption_mode = 'single_per_user' THEN
        SELECT COUNT(*) INTO v_already_used FROM public.discount_redemptions
        WHERE code_id = v_code.id AND user_id = v_uid;
        v_valid := v_already_used = 0;
      ELSIF v_code.redemption_mode = 'multi_use_capped' THEN
        v_valid := v_code.times_redeemed < COALESCE(v_code.max_redemptions, 0);
      ELSE
        v_valid := true;
      END IF;
    END IF;
  END IF;
  IF v_valid THEN
    v_discount := ROUND(v_plan_price * v_code.percent_off / 100.0, 2);
    NEW.discount_code := upper(trim(NEW.discount_code));
    NEW.discount_amount_usd := v_discount;
    NEW.amount_usd := ROUND(v_plan_price - v_discount, 2);
  ELSE
    NEW.discount_code := NULL;
    NEW.discount_amount_usd := NULL;
    NEW.amount_usd := v_plan_price;
  END IF;
  RETURN NEW;
END;
$$;

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
  -- reseller sale: the reseller issues his customer's key through reseller_record_sale()
  IF v_role <> 'service_role'
     AND COALESCE(current_setting('app.reseller_sale', true), '') <> 'on'
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
    v_plan_name || CASE WHEN v_payment.billing_period = 'annual' THEN ' (Annual)' ELSE '' END,
    true,
    (v_minutes::BIGINT) * 60000 * CASE WHEN v_payment.billing_period = 'annual' THEN 12 ELSE 1 END,
    v_payment.id,
    NULL
  )
  RETURNING id INTO v_new_key_id;
  UPDATE public.payments SET pending_key_assignment = false WHERE id = p_payment_id;
  RETURN v_new_key_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_payments_notify_non_primary_confirm()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  supabase_url text := 'https://bbxahisheugfryyxfidg.supabase.co';
  service_key text;
  v_actor uuid := auth.uid();
  v_primary_admin_id uuid;
  v_actor_email text;
  v_actor_role text;
  v_target_who text;
  became_confirmed boolean := false;
BEGIN
  -- reseller sale: confirmed by the reseller console, not by a staff member
  IF COALESCE(current_setting('app.reseller_sale', true), '') = 'on' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    became_confirmed := NEW.status = 'confirmed';
  ELSIF TG_OP = 'UPDATE' THEN
    became_confirmed := NEW.status = 'confirmed' AND OLD.status IS DISTINCT FROM 'confirmed';
  END IF;
  IF NOT became_confirmed OR v_actor IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT id INTO v_primary_admin_id FROM auth.users WHERE email = 'elotetoolz@gmail.com' LIMIT 1;
  IF v_primary_admin_id IS NOT NULL AND v_actor = v_primary_admin_id THEN
    RETURN NEW;
  END IF;
  BEGIN
    SELECT decrypted_secret INTO service_key
    FROM vault.decrypted_secrets
    WHERE name = 'email_queue_service_role_key'
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN service_key := NULL;
  END;
  IF service_key IS NULL THEN RETURN NEW; END IF;
  SELECT u.email, COALESCE(ur.role::text, 'no role')
    INTO v_actor_email, v_actor_role
    FROM auth.users u
    LEFT JOIN public.user_roles ur ON ur.user_id = u.id
   WHERE u.id = v_actor
   LIMIT 1;
  SELECT COALESCE(email, display_name, NEW.user_id::text) INTO v_target_who
    FROM public.profiles WHERE user_id = NEW.user_id LIMIT 1;
  PERFORM net.http_post(
    url := supabase_url || '/functions/v1/send-admin-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    body := jsonb_build_object(
      'event', 'payment_confirmed_by_non_primary',
      'title', '⚠️ Payment confirmed by someone other than you',
      'body', concat_ws(' • ',
        COALESCE(v_actor_email, v_actor::text) || ' (' || COALESCE(v_actor_role, 'no role') || ')',
        '$' || COALESCE(NEW.amount_usd::text, '?') || ' for ' || COALESCE(v_target_who, NEW.user_id::text)
      ),
      'url', '/admin',
      'tag', 'payment-non-primary-confirm-' || NEW.id
    )
  );
  RETURN NEW;
END;
$function$;

-- ============================================================================ ledger

CREATE OR REPLACE FUNCTION public._reseller_post(
  p_reseller_id uuid, p_kind text, p_amount numeric, p_topup_id uuid, p_sale_id uuid, p_note text
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance numeric;
BEGIN
  SELECT balance_usd INTO v_balance FROM public.resellers WHERE id = p_reseller_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reseller not found' USING ERRCODE = '22023';
  END IF;
  v_balance := round(v_balance + p_amount, 2);
  IF v_balance < 0 THEN
    RAISE EXCEPTION 'Not enough balance for this change' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.reseller_ledger', 'on', true);
  UPDATE public.resellers SET balance_usd = v_balance WHERE id = p_reseller_id;
  PERFORM set_config('app.reseller_ledger', 'off', true);
  INSERT INTO public.reseller_ledger (reseller_id, kind, amount_usd, balance_after_usd, topup_id, sale_id, note, created_by)
  VALUES (p_reseller_id, p_kind, round(p_amount, 2), v_balance, p_topup_id, p_sale_id, p_note, auth.uid());
  RETURN v_balance;
END;
$$;
REVOKE ALL ON FUNCTION public._reseller_post(uuid, text, numeric, uuid, uuid, text) FROM PUBLIC, anon, authenticated;

-- Public storefront data: approved prices for active plans that can be resold.
CREATE OR REPLACE FUNCTION public._reseller_storefront(p_reseller_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'code', r.code,
    'display_name', r.display_name,
    'contact', r.contact,
    'plans', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'plan_id', pp.id,
               'name', pp.name,
               'description', pp.description,
               'features', to_jsonb(pp.features),
               'minutes', pp.key_duration_minutes,
               'monthly_price_usd', pm.price_usd,
               'annual_price_usd', CASE WHEN pp.price_usd_annual IS NOT NULL THEN pa.price_usd END
             ) ORDER BY pp.sort_order)
        FROM public.pricing_plans pp
        LEFT JOIN public.reseller_prices pm ON pm.reseller_id = r.id AND pm.plan_id = pp.id AND pm.billing_period = 'monthly'
        LEFT JOIN public.reseller_prices pa ON pa.reseller_id = r.id AND pa.plan_id = pp.id AND pa.billing_period = 'annual'
       WHERE pp.is_active AND pp.price_usd > 0 AND COALESCE(pp.key_duration_minutes, 0) > 0
         AND (pm.price_usd IS NOT NULL OR pa.price_usd IS NOT NULL)
    ), '[]'::jsonb)
  )
  FROM public.resellers r
  WHERE r.id = p_reseller_id;
$$;
REVOKE ALL ON FUNCTION public._reseller_storefront(uuid) FROM PUBLIC, anon, authenticated;

-- ============================================================================ public + customer

CREATE OR REPLACE FUNCTION public.reseller_public_profile(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM public.resellers WHERE code = upper(btrim(p_code)) AND is_active;
  IF v_id IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN public._reseller_storefront(v_id);
END;
$$;
REVOKE ALL ON FUNCTION public.reseller_public_profile(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reseller_public_profile(text) TO anon, authenticated;

-- The signed-in customer's reseller (only while that reseller is active), or NULL.
CREATE OR REPLACE FUNCTION public.my_reseller()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT c.reseller_id INTO v_id
    FROM public.reseller_customers c
    JOIN public.resellers r ON r.id = c.reseller_id
   WHERE c.user_id = auth.uid() AND r.is_active;
  IF v_id IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN public._reseller_storefront(v_id);
END;
$$;
REVOKE ALL ON FUNCTION public.my_reseller() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_reseller() TO authenticated;

-- What the customer paid their reseller (never the split).
CREATE OR REPLACE FUNCTION public.my_reseller_purchases()
RETURNS TABLE(payment_id uuid, plan_name text, billing_period text, price_usd numeric, reseller_name text, created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.payment_id, s.plan_name, s.billing_period, s.reseller_price_usd, r.display_name, s.created_at
    FROM public.reseller_sales s
    JOIN public.resellers r ON r.id = s.reseller_id
   WHERE s.customer_user_id = auth.uid() AND s.status = 'active'
   ORDER BY s.created_at DESC;
$$;
REVOKE ALL ON FUNCTION public.my_reseller_purchases() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_reseller_purchases() TO authenticated;

-- Link the signed-in account to a reseller by code. Only for accounts that haven't bought a plan
-- from Elite Swap and aren't a partner referral, so an existing customer can't be moved away from
-- direct purchases by clicking a link (an admin can still link anyone).
CREATE OR REPLACE FUNCTION public.attach_reseller_code(p_code text, p_source text DEFAULT 'link')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_r public.resellers%ROWTYPE;
  v_existing text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_r FROM public.resellers WHERE code = upper(btrim(p_code)) AND is_active;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_code');
  END IF;
  SELECT r.display_name INTO v_existing
    FROM public.reseller_customers c JOIN public.resellers r ON r.id = c.reseller_id
   WHERE c.user_id = v_uid;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_linked', 'reseller_name', v_existing);
  END IF;
  IF v_r.user_id = v_uid OR EXISTS (SELECT 1 FROM public.resellers WHERE user_id = v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'is_reseller');
  END IF;
  IF EXISTS (SELECT 1 FROM public.partner_attributions WHERE user_id = v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'has_partner');
  END IF;
  IF EXISTS (SELECT 1 FROM public.payments
              WHERE user_id = v_uid AND status = 'confirmed' AND plan_id IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'existing_customer');
  END IF;
  INSERT INTO public.reseller_customers (user_id, reseller_id, source)
  VALUES (v_uid, v_r.id, CASE WHEN p_source = 'code' THEN 'code' ELSE 'link' END);
  RETURN jsonb_build_object('ok', true, 'reseller_name', v_r.display_name, 'code', v_r.code);
END;
$$;
REVOKE ALL ON FUNCTION public.attach_reseller_code(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attach_reseller_code(text, text) TO authenticated;

-- ============================================================================ reseller console

CREATE OR REPLACE FUNCTION public._caller_reseller(p_require_active boolean DEFAULT true)
RETURNS public.resellers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_r public.resellers%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_r FROM public.resellers WHERE user_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This account isn''t a reseller' USING ERRCODE = '42501';
  END IF;
  IF p_require_active AND NOT v_r.is_active THEN
    RAISE EXCEPTION 'Your reseller account is paused. Contact Elite Swap.' USING ERRCODE = '42501';
  END IF;
  RETURN v_r;
END;
$$;
REVOKE ALL ON FUNCTION public._caller_reseller(boolean) FROM PUBLIC, anon, authenticated;

-- A sale can be voided by its reseller within 24 hours while its key is untouched.
CREATE OR REPLACE FUNCTION public._reseller_sale_voidable(p_sale public.reseller_sales)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_sale.status = 'active'
     AND p_sale.created_at > now() - interval '24 hours'
     AND EXISTS (
       SELECT 1 FROM public.api_keys k
        WHERE k.id = p_sale.api_key_id
          AND k.is_active
          AND k.active_session_id IS NULL
          AND k.remaining_ms IS NOT DISTINCT FROM p_sale.key_ms
     )
     AND NOT EXISTS (SELECT 1 FROM public.studio_sessions ss WHERE ss.api_key_id = p_sale.api_key_id);
$$;
REVOKE ALL ON FUNCTION public._reseller_sale_voidable(public.reseller_sales) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.reseller_dashboard()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_r public.resellers%ROWTYPE := public._caller_reseller(false);
BEGIN
  RETURN jsonb_build_object(
    'reseller', jsonb_build_object(
      'id', v_r.id, 'code', v_r.code, 'display_name', v_r.display_name, 'contact', v_r.contact,
      'balance_usd', v_r.balance_usd, 'is_active', v_r.is_active),
    'plans', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'plan_id', pp.id, 'name', pp.name, 'minutes', pp.key_duration_minutes,
               'list_monthly_usd', pp.price_usd, 'list_annual_usd', pp.price_usd_annual,
               'monthly_price_usd', pm.price_usd, 'monthly_proposed_usd', pm.proposed_price_usd,
               'annual_price_usd', pa.price_usd, 'annual_proposed_usd', pa.proposed_price_usd
             ) ORDER BY pp.sort_order)
        FROM public.pricing_plans pp
        LEFT JOIN public.reseller_prices pm ON pm.reseller_id = v_r.id AND pm.plan_id = pp.id AND pm.billing_period = 'monthly'
        LEFT JOIN public.reseller_prices pa ON pa.reseller_id = v_r.id AND pa.plan_id = pp.id AND pa.billing_period = 'annual'
       WHERE pp.is_active AND pp.price_usd > 0 AND COALESCE(pp.key_duration_minutes, 0) > 0
    ), '[]'::jsonb),
    'customers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'user_id', c.user_id, 'email', p.email, 'display_name', p.display_name,
               'attached_at', c.attached_at,
               'remaining_ms', (SELECT COALESCE(sum(k.remaining_ms), 0) FROM public.api_keys k
                                 WHERE k.user_id = c.user_id AND k.is_active AND COALESCE(k.remaining_ms, 0) > 0),
               'purchases', (SELECT count(*) FROM public.reseller_sales s
                              WHERE s.customer_user_id = c.user_id AND s.reseller_id = v_r.id AND s.status = 'active')
             ) ORDER BY c.attached_at DESC)
        FROM public.reseller_customers c
        LEFT JOIN public.profiles p ON p.user_id = c.user_id
       WHERE c.reseller_id = v_r.id
    ), '[]'::jsonb),
    'sales', COALESCE((
      SELECT jsonb_agg(x.j ORDER BY x.created_at DESC) FROM (
        SELECT s.created_at, jsonb_build_object(
                 'id', s.id, 'customer_user_id', s.customer_user_id, 'customer_email', p.email,
                 'plan_name', s.plan_name, 'billing_period', s.billing_period,
                 'list_price_usd', s.list_price_usd, 'price_usd', s.reseller_price_usd,
                 'platform_share_usd', s.platform_share_usd, 'reseller_share_usd', s.reseller_share_usd,
                 'status', s.status, 'created_at', s.created_at, 'voided_at', s.voided_at,
                 'can_void', public._reseller_sale_voidable(s)) AS j
          FROM public.reseller_sales s
          LEFT JOIN public.profiles p ON p.user_id = s.customer_user_id
         WHERE s.reseller_id = v_r.id
         ORDER BY s.created_at DESC
         LIMIT 300) x
    ), '[]'::jsonb),
    'ledger', COALESCE((
      SELECT jsonb_agg(x.j ORDER BY x.created_at DESC) FROM (
        SELECT l.created_at, jsonb_build_object(
                 'id', l.id, 'kind', l.kind, 'amount_usd', l.amount_usd,
                 'balance_after_usd', l.balance_after_usd, 'note', l.note, 'created_at', l.created_at) AS j
          FROM public.reseller_ledger l
         WHERE l.reseller_id = v_r.id
         ORDER BY l.created_at DESC
         LIMIT 300) x
    ), '[]'::jsonb),
    'topups', COALESCE((
      SELECT jsonb_agg(x.j ORDER BY x.created_at DESC) FROM (
        SELECT t.created_at, jsonb_build_object(
                 'id', t.id, 'amount_usd', t.amount_usd, 'currency', t.currency, 'tx_hash', t.tx_hash,
                 'status', t.status, 'credited_usd', t.credited_usd, 'review_note', t.review_note,
                 'created_at', t.created_at, 'reviewed_at', t.reviewed_at) AS j
          FROM public.reseller_topups t
         WHERE t.reseller_id = v_r.id
         ORDER BY t.created_at DESC
         LIMIT 100) x
    ), '[]'::jsonb)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.reseller_dashboard() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reseller_dashboard() TO authenticated;

-- Propose a price (an admin approves it). At or above the list price; the approved price keeps
-- applying to sales until then.
CREATE OR REPLACE FUNCTION public.reseller_propose_price(p_plan_id uuid, p_billing_period text, p_price_usd numeric)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_r public.resellers%ROWTYPE := public._caller_reseller(true);
  v_period text := CASE WHEN p_billing_period = 'annual' THEN 'annual' ELSE 'monthly' END;
  v_list numeric;
  v_price numeric := round(p_price_usd, 2);
BEGIN
  SELECT CASE WHEN v_period = 'annual' THEN price_usd_annual ELSE price_usd END INTO v_list
    FROM public.pricing_plans
   WHERE id = p_plan_id AND is_active AND price_usd > 0 AND COALESCE(key_duration_minutes, 0) > 0;
  IF v_list IS NULL OR v_list <= 0 THEN
    RAISE EXCEPTION 'This plan can''t be resold%', CASE WHEN v_period = 'annual' THEN ' annually' ELSE '' END USING ERRCODE = '22023';
  END IF;
  IF v_price IS NULL OR v_price < v_list THEN
    RAISE EXCEPTION 'Your price can''t be below the list price of $%', to_char(v_list, 'FM999999990.00') USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.reseller_prices (reseller_id, plan_id, billing_period, proposed_price_usd, proposed_at, updated_at)
  VALUES (v_r.id, p_plan_id, v_period, v_price, now(), now())
  ON CONFLICT (reseller_id, plan_id, billing_period) DO UPDATE
    SET proposed_price_usd = CASE WHEN reseller_prices.price_usd = EXCLUDED.proposed_price_usd THEN NULL ELSE EXCLUDED.proposed_price_usd END,
        proposed_at = CASE WHEN reseller_prices.price_usd = EXCLUDED.proposed_price_usd THEN NULL ELSE now() END,
        updated_at = now();
  RETURN jsonb_build_object('ok', true);
END;
$$;
REVOKE ALL ON FUNCTION public.reseller_propose_price(uuid, text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reseller_propose_price(uuid, text, numeric) TO authenticated;

CREATE OR REPLACE FUNCTION public.reseller_update_contact(p_contact text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_r public.resellers%ROWTYPE := public._caller_reseller(false);
BEGIN
  UPDATE public.resellers SET contact = left(p_contact, 120) WHERE id = v_r.id;
  RETURN jsonb_build_object('ok', true);
END;
$$;
REVOKE ALL ON FUNCTION public.reseller_update_contact(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reseller_update_contact(text) TO authenticated;

-- Report a crypto transfer to Elite Swap's wallets; an admin checks it and credits the balance.
CREATE OR REPLACE FUNCTION public.reseller_submit_topup(p_amount_usd numeric, p_currency text, p_tx_hash text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_r public.resellers%ROWTYPE := public._caller_reseller(false);
  v_hash text := btrim(p_tx_hash);
  v_id uuid;
BEGIN
  IF p_amount_usd IS NULL OR p_amount_usd <= 0 OR p_amount_usd > 100000 THEN
    RAISE EXCEPTION 'Enter the amount you sent, in USD' USING ERRCODE = '22023';
  END IF;
  IF v_hash IS NULL OR length(v_hash) < 10 THEN
    RAISE EXCEPTION 'Paste the transaction hash of your transfer' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.reseller_topups WHERE lower(tx_hash) = lower(v_hash))
     OR EXISTS (SELECT 1 FROM public.payments WHERE lower(tx_hash) = lower(v_hash))
     OR EXISTS (SELECT 1 FROM public.trial_purchases WHERE lower(provider_reference) = lower(v_hash)) THEN
    RAISE EXCEPTION 'That transaction has already been submitted' USING ERRCODE = '23505';
  END IF;
  IF (SELECT count(*) FROM public.reseller_topups WHERE reseller_id = v_r.id AND status = 'pending') >= 5 THEN
    RAISE EXCEPTION 'You have 5 top-ups waiting for review. Wait for those first.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.reseller_topups (reseller_id, amount_usd, currency, tx_hash)
  VALUES (v_r.id, round(p_amount_usd, 2), p_currency, v_hash)
  RETURNING id INTO v_id;
  PERFORM public.app_notify(ur.user_id, 'payment', 'admin_reseller_topup', 'Reseller top-up to review',
          v_r.display_name || ' sent $' || to_char(round(p_amount_usd, 2), 'FM999999990.00') || ' in ' || p_currency,
          '/admin', 'info', 'reseller_topup', v_id, v_r.user_id, '{}'::jsonb)
     FROM public.user_roles ur WHERE ur.role = 'admin'::app_role;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$;
REVOKE ALL ON FUNCTION public.reseller_submit_topup(numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reseller_submit_topup(numeric, text, text) TO authenticated;

-- Sell a plan to one of his customers. Elite Swap's share (list + half the markup) comes off his
-- balance at once; the customer's key is issued in the same transaction.
CREATE OR REPLACE FUNCTION public.reseller_record_sale(p_customer_user_id uuid, p_plan_id uuid, p_billing_period text DEFAULT 'monthly')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_r public.resellers%ROWTYPE := public._caller_reseller(true);
  v_period text := CASE WHEN p_billing_period = 'annual' THEN 'annual' ELSE 'monthly' END;
  v_plan public.pricing_plans%ROWTYPE;
  v_list numeric;
  v_price numeric;
  v_platform numeric;
  v_share numeric;
  v_sale_id uuid := gen_random_uuid();
  v_payment_id uuid;
  v_key public.api_keys%ROWTYPE;
  v_balance numeric;
BEGIN
  -- serialise this reseller's sales so two at once can't both spend the same balance
  PERFORM 1 FROM public.resellers WHERE id = v_r.id FOR UPDATE;
  SELECT * INTO v_r FROM public.resellers WHERE id = v_r.id;
  IF NOT EXISTS (SELECT 1 FROM public.reseller_customers WHERE user_id = p_customer_user_id AND reseller_id = v_r.id) THEN
    RAISE EXCEPTION 'That customer isn''t linked to you' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_plan FROM public.pricing_plans WHERE id = p_plan_id AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Plan not found' USING ERRCODE = '22023';
  END IF;
  v_list := CASE WHEN v_period = 'annual' THEN v_plan.price_usd_annual ELSE v_plan.price_usd END;
  IF v_list IS NULL OR v_list <= 0 OR COALESCE(v_plan.key_duration_minutes, 0) <= 0 THEN
    RAISE EXCEPTION 'This plan can''t be resold%', CASE WHEN v_period = 'annual' THEN ' annually' ELSE '' END USING ERRCODE = '22023';
  END IF;
  SELECT price_usd INTO v_price FROM public.reseller_prices
   WHERE reseller_id = v_r.id AND plan_id = p_plan_id AND billing_period = v_period;
  IF v_price IS NULL THEN
    RAISE EXCEPTION 'You don''t have an approved price for % (%) yet', v_plan.name, v_period USING ERRCODE = '22023';
  END IF;
  IF v_price < v_list THEN
    RAISE EXCEPTION 'The list price of % is now $%, above your price. Propose a new price first.',
      v_plan.name, to_char(v_list, 'FM999999990.00') USING ERRCODE = '22023';
  END IF;
  v_platform := round(v_list + (v_price - v_list) / 2.0, 2);
  v_share := v_price - v_platform;
  IF v_r.balance_usd < v_platform THEN
    RAISE EXCEPTION 'Not enough balance: this sale needs $% and you have $%. Top up first.',
      to_char(v_platform, 'FM999999990.00'), to_char(v_r.balance_usd, 'FM999999990.00') USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('app.reseller_sale', 'on', true);
  INSERT INTO public.payments (user_id, currency, tx_hash, status, payment_method, plan_id, billing_period, amount_usd)
  VALUES (p_customer_user_id, NULL, NULL, 'confirmed', 'reseller', p_plan_id, v_period, v_platform)
  RETURNING id INTO v_payment_id;
  PERFORM set_config('app.reseller_sale', 'off', true);

  SELECT * INTO v_key FROM public.api_keys WHERE payment_id = v_payment_id ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The customer''s key could not be issued; nothing was charged' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.reseller_sales (id, reseller_id, customer_user_id, plan_id, plan_name, billing_period,
                                     list_price_usd, reseller_price_usd, platform_share_usd, reseller_share_usd,
                                     payment_id, api_key_id, key_ms)
  VALUES (v_sale_id, v_r.id, p_customer_user_id, p_plan_id, v_plan.name, v_period,
          v_list, v_price, v_platform, v_share, v_payment_id, v_key.id, v_key.remaining_ms);
  v_balance := public._reseller_post(v_r.id, 'sale', -v_platform, NULL, v_sale_id,
                                     v_plan.name || CASE WHEN v_period = 'annual' THEN ' (Annual)' ELSE '' END);
  RETURN jsonb_build_object(
    'ok', true, 'sale_id', v_sale_id, 'plan_name', v_plan.name, 'billing_period', v_period,
    'price_usd', v_price, 'platform_share_usd', v_platform, 'reseller_share_usd', v_share,
    'balance_usd', v_balance, 'key_label', v_key.label, 'minutes', v_key.remaining_ms / 60000);
END;
$$;
REVOKE ALL ON FUNCTION public.reseller_record_sale(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reseller_record_sale(uuid, uuid, text) TO authenticated;

-- Undo a sale within 24 hours while the key is unused: the key is switched off, the payment row
-- behind it removed (so finance and plan checks forget it), and his balance refunded in full.
CREATE OR REPLACE FUNCTION public.reseller_void_sale(p_sale_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_r public.resellers%ROWTYPE := public._caller_reseller(false);
  v_sale public.reseller_sales%ROWTYPE;
  v_balance numeric;
BEGIN
  SELECT * INTO v_sale FROM public.reseller_sales WHERE id = p_sale_id AND reseller_id = v_r.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found' USING ERRCODE = '22023';
  END IF;
  IF v_sale.status <> 'active' THEN
    RAISE EXCEPTION 'This sale is already cancelled' USING ERRCODE = '22023';
  END IF;
  IF v_sale.created_at <= now() - interval '24 hours' THEN
    RAISE EXCEPTION 'Sales can only be cancelled within 24 hours' USING ERRCODE = '22023';
  END IF;
  -- lock the key so a studio connect can't start between the check and the switch-off
  PERFORM 1 FROM public.api_keys WHERE id = v_sale.api_key_id FOR UPDATE;
  IF NOT public._reseller_sale_voidable(v_sale) THEN
    RAISE EXCEPTION 'This key has already been used, so the sale can''t be cancelled' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.bypass_key_guard', 'on', true);
  UPDATE public.api_keys SET is_active = false WHERE id = v_sale.api_key_id;
  PERFORM set_config('app.bypass_key_guard', 'off', true);
  DELETE FROM public.payments WHERE id = v_sale.payment_id AND payment_method = 'reseller';
  UPDATE public.reseller_sales
     SET status = 'voided', voided_at = now(), void_reason = left(NULLIF(btrim(p_reason), ''), 300)
   WHERE id = v_sale.id;
  v_balance := public._reseller_post(v_r.id, 'void', v_sale.platform_share_usd, NULL, v_sale.id,
                                     'Cancelled: ' || v_sale.plan_name);
  RETURN jsonb_build_object('ok', true, 'refunded_usd', v_sale.platform_share_usd, 'balance_usd', v_balance);
END;
$$;
REVOKE ALL ON FUNCTION public.reseller_void_sale(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reseller_void_sale(uuid, text) TO authenticated;

-- ============================================================================ admin

CREATE OR REPLACE FUNCTION public._require_admin()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'Admins only' USING ERRCODE = '42501';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public._require_admin() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_create_reseller(p_user_id uuid, p_code text, p_display_name text, p_contact text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM public._require_admin();
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = p_user_id) THEN
    RAISE EXCEPTION 'No account found for that user' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.reseller_customers WHERE user_id = p_user_id) THEN
    RAISE EXCEPTION 'That account is a reseller''s customer; unlink it first' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.resellers (user_id, code, display_name, contact, created_by)
  VALUES (p_user_id, p_code, p_display_name, p_contact, auth.uid())
  RETURNING id INTO v_id;
  PERFORM public.log_admin_action('reseller_create', 'reseller', v_id::text, NULL,
    jsonb_build_object('user_id', p_user_id, 'code', upper(btrim(p_code)), 'display_name', p_display_name, 'contact', p_contact));
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_create_reseller(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_reseller(uuid, text, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_update_reseller(p_reseller_id uuid, p_display_name text, p_contact text, p_is_active boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_before public.resellers%ROWTYPE;
BEGIN
  PERFORM public._require_admin();
  SELECT * INTO v_before FROM public.resellers WHERE id = p_reseller_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reseller not found' USING ERRCODE = '22023';
  END IF;
  UPDATE public.resellers
     SET display_name = COALESCE(NULLIF(btrim(p_display_name), ''), display_name),
         contact = p_contact,
         is_active = COALESCE(p_is_active, is_active)
   WHERE id = p_reseller_id;
  PERFORM public.log_admin_action('reseller_update', 'reseller', p_reseller_id::text,
    jsonb_build_object('display_name', v_before.display_name, 'contact', v_before.contact, 'is_active', v_before.is_active),
    jsonb_build_object('display_name', p_display_name, 'contact', p_contact, 'is_active', p_is_active));
END;
$$;
REVOKE ALL ON FUNCTION public.admin_update_reseller(uuid, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_reseller(uuid, text, text, boolean) TO authenticated;

-- Set (or clear, with NULL) the approved price directly; clears any pending proposal.
CREATE OR REPLACE FUNCTION public.admin_set_reseller_price(p_reseller_id uuid, p_plan_id uuid, p_billing_period text, p_price_usd numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_period text := CASE WHEN p_billing_period = 'annual' THEN 'annual' ELSE 'monthly' END;
  v_list numeric;
  v_price numeric := round(p_price_usd, 2);
  v_old numeric;
BEGIN
  PERFORM public._require_admin();
  SELECT CASE WHEN v_period = 'annual' THEN price_usd_annual ELSE price_usd END INTO v_list
    FROM public.pricing_plans WHERE id = p_plan_id;
  IF v_price IS NOT NULL AND (v_list IS NULL OR v_price < v_list) THEN
    RAISE EXCEPTION 'The price can''t be below the list price of $%', COALESCE(to_char(v_list, 'FM999999990.00'), '?') USING ERRCODE = '22023';
  END IF;
  SELECT price_usd INTO v_old FROM public.reseller_prices
   WHERE reseller_id = p_reseller_id AND plan_id = p_plan_id AND billing_period = v_period;
  INSERT INTO public.reseller_prices (reseller_id, plan_id, billing_period, price_usd, approved_at, approved_by, updated_at)
  VALUES (p_reseller_id, p_plan_id, v_period, v_price, now(), auth.uid(), now())
  ON CONFLICT (reseller_id, plan_id, billing_period) DO UPDATE
    SET price_usd = EXCLUDED.price_usd, proposed_price_usd = NULL, proposed_at = NULL,
        approved_at = now(), approved_by = auth.uid(), updated_at = now();
  PERFORM public.log_admin_action('reseller_price_set', 'reseller', p_reseller_id::text,
    jsonb_build_object('plan_id', p_plan_id, 'billing_period', v_period, 'price_usd', v_old),
    jsonb_build_object('plan_id', p_plan_id, 'billing_period', v_period, 'price_usd', v_price));
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_reseller_price(uuid, uuid, text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_reseller_price(uuid, uuid, text, numeric) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_review_reseller_price(p_reseller_id uuid, p_plan_id uuid, p_billing_period text, p_approve boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_period text := CASE WHEN p_billing_period = 'annual' THEN 'annual' ELSE 'monthly' END;
  v_row public.reseller_prices%ROWTYPE;
  v_list numeric;
BEGIN
  PERFORM public._require_admin();
  SELECT * INTO v_row FROM public.reseller_prices
   WHERE reseller_id = p_reseller_id AND plan_id = p_plan_id AND billing_period = v_period FOR UPDATE;
  IF NOT FOUND OR v_row.proposed_price_usd IS NULL THEN
    RAISE EXCEPTION 'No price is waiting for review' USING ERRCODE = '22023';
  END IF;
  IF p_approve THEN
    SELECT CASE WHEN v_period = 'annual' THEN price_usd_annual ELSE price_usd END INTO v_list
      FROM public.pricing_plans WHERE id = p_plan_id;
    IF v_list IS NULL OR v_row.proposed_price_usd < v_list THEN
      RAISE EXCEPTION 'The proposed price is below the current list price' USING ERRCODE = '22023';
    END IF;
    UPDATE public.reseller_prices
       SET price_usd = proposed_price_usd, proposed_price_usd = NULL, proposed_at = NULL,
           approved_at = now(), approved_by = auth.uid(), updated_at = now()
     WHERE reseller_id = p_reseller_id AND plan_id = p_plan_id AND billing_period = v_period;
  ELSE
    UPDATE public.reseller_prices SET proposed_price_usd = NULL, proposed_at = NULL, updated_at = now()
     WHERE reseller_id = p_reseller_id AND plan_id = p_plan_id AND billing_period = v_period;
  END IF;
  PERFORM public.log_admin_action(CASE WHEN p_approve THEN 'reseller_price_approve' ELSE 'reseller_price_reject' END,
    'reseller', p_reseller_id::text,
    jsonb_build_object('plan_id', p_plan_id, 'billing_period', v_period, 'price_usd', v_row.price_usd),
    jsonb_build_object('plan_id', p_plan_id, 'billing_period', v_period, 'proposed_price_usd', v_row.proposed_price_usd));
END;
$$;
REVOKE ALL ON FUNCTION public.admin_review_reseller_price(uuid, uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_review_reseller_price(uuid, uuid, text, boolean) TO authenticated;

-- Approve (crediting what actually arrived, which may differ from what he typed) or reject.
CREATE OR REPLACE FUNCTION public.admin_review_reseller_topup(p_topup_id uuid, p_approve boolean, p_credit_usd numeric DEFAULT NULL, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_t public.reseller_topups%ROWTYPE;
  v_credit numeric;
  v_balance numeric;
  v_user uuid;
BEGIN
  PERFORM public._require_admin();
  SELECT * INTO v_t FROM public.reseller_topups WHERE id = p_topup_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Top-up not found' USING ERRCODE = '22023';
  END IF;
  IF v_t.status <> 'pending' THEN
    RAISE EXCEPTION 'This top-up was already reviewed' USING ERRCODE = '22023';
  END IF;
  SELECT user_id INTO v_user FROM public.resellers WHERE id = v_t.reseller_id;
  IF p_approve THEN
    v_credit := round(COALESCE(p_credit_usd, v_t.amount_usd), 2);
    IF v_credit <= 0 THEN
      RAISE EXCEPTION 'The amount to credit must be above zero' USING ERRCODE = '22023';
    END IF;
    UPDATE public.reseller_topups
       SET status = 'approved', credited_usd = v_credit, review_note = NULLIF(btrim(p_note), ''),
           reviewed_by = auth.uid(), reviewed_at = now()
     WHERE id = v_t.id;
    v_balance := public._reseller_post(v_t.reseller_id, 'topup', v_credit, v_t.id, NULL,
                                       'Top-up ' || v_t.currency || ' ' || left(v_t.tx_hash, 12) || '…');
    PERFORM public.app_notify(v_user, 'payment', 'reseller_topup_approved', 'Top-up credited',
      '$' || to_char(v_credit, 'FM999999990.00') || ' was added to your reseller balance.',
      '/reseller', 'success', 'reseller_topup', v_t.id, NULL, '{}'::jsonb);
  ELSE
    UPDATE public.reseller_topups
       SET status = 'rejected', review_note = NULLIF(btrim(p_note), ''), reviewed_by = auth.uid(), reviewed_at = now()
     WHERE id = v_t.id;
    PERFORM public.app_notify(v_user, 'payment', 'reseller_topup_rejected', 'Top-up not credited',
      COALESCE(NULLIF(btrim(p_note), ''), 'We couldn''t match this transfer. Contact Elite Swap.'),
      '/reseller', 'warning', 'reseller_topup', v_t.id, NULL, '{}'::jsonb);
  END IF;
  PERFORM public.log_admin_action(CASE WHEN p_approve THEN 'reseller_topup_approve' ELSE 'reseller_topup_reject' END,
    'reseller_topup', v_t.id::text,
    jsonb_build_object('amount_usd', v_t.amount_usd, 'currency', v_t.currency, 'tx_hash', v_t.tx_hash),
    jsonb_build_object('credited_usd', v_credit, 'note', p_note));
  RETURN jsonb_build_object('ok', true, 'balance_usd', v_balance);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_review_reseller_topup(uuid, boolean, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_review_reseller_topup(uuid, boolean, numeric, text) TO authenticated;

-- Manual correction (e.g. a refund settled outside the system). Positive credits, negative debits.
CREATE OR REPLACE FUNCTION public.admin_adjust_reseller_balance(p_reseller_id uuid, p_amount_usd numeric, p_note text)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance numeric;
BEGIN
  PERFORM public._require_admin();
  IF p_amount_usd IS NULL OR round(p_amount_usd, 2) = 0 THEN
    RAISE EXCEPTION 'Enter a non-zero amount' USING ERRCODE = '22023';
  END IF;
  IF p_note IS NULL OR length(btrim(p_note)) < 3 THEN
    RAISE EXCEPTION 'Add a note explaining the adjustment' USING ERRCODE = '22023';
  END IF;
  v_balance := public._reseller_post(p_reseller_id, 'adjustment', p_amount_usd, NULL, NULL, btrim(p_note));
  PERFORM public.log_admin_action('reseller_balance_adjust', 'reseller', p_reseller_id::text, NULL,
    jsonb_build_object('amount_usd', round(p_amount_usd, 2), 'note', p_note, 'balance_after_usd', v_balance));
  RETURN v_balance;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_adjust_reseller_balance(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_adjust_reseller_balance(uuid, numeric, text) TO authenticated;

-- Link a customer to a reseller (or unlink with NULL, after which they can buy directly again).
CREATE OR REPLACE FUNCTION public.admin_set_reseller_customer(p_user_id uuid, p_reseller_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_before uuid;
BEGIN
  PERFORM public._require_admin();
  SELECT reseller_id INTO v_before FROM public.reseller_customers WHERE user_id = p_user_id;
  IF p_reseller_id IS NULL THEN
    DELETE FROM public.reseller_customers WHERE user_id = p_user_id;
  ELSE
    IF EXISTS (SELECT 1 FROM public.resellers WHERE user_id = p_user_id) THEN
      RAISE EXCEPTION 'A reseller can''t be a customer' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM public.partner_attributions WHERE user_id = p_user_id) THEN
      RAISE EXCEPTION 'That account is a partner referral; remove the referral first' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.reseller_customers (user_id, reseller_id, source)
    VALUES (p_user_id, p_reseller_id, 'admin')
    ON CONFLICT (user_id) DO UPDATE SET reseller_id = EXCLUDED.reseller_id, source = 'admin', attached_at = now();
  END IF;
  PERFORM public.log_admin_action('reseller_customer_set', 'user', p_user_id::text,
    jsonb_build_object('reseller_id', v_before), jsonb_build_object('reseller_id', p_reseller_id));
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_reseller_customer(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_reseller_customer(uuid, uuid) TO authenticated;
