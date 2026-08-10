-- Helpers
CREATE OR REPLACE FUNCTION public.is_sec_admin(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT public.has_role(_user_id, 'sec_admin'::app_role) $$;

CREATE OR REPLACE FUNCTION public.can_manage_payments(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT public.has_role(_user_id, 'admin'::app_role) OR public.has_role(_user_id, 'sec_admin'::app_role) $$;

CREATE OR REPLACE FUNCTION public.can_manage_discounts(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT public.has_role(_user_id, 'admin'::app_role) OR public.has_role(_user_id, 'sec_admin'::app_role) $$;

-- Update is_staff to include sec_admin (preserve param name)
CREATE OR REPLACE FUNCTION public.is_staff(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT public.has_role(_user_id, 'admin'::app_role)
      OR public.has_role(_user_id, 'moderator'::app_role)
      OR public.has_role(_user_id, 'sec_admin'::app_role)
$$;

-- PAYMENTS
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT policyname FROM pg_policies
    WHERE schemaname='public' AND tablename='payments'
      AND (coalesce(qual,'') ILIKE '%has_role(auth.uid()%admin%' OR coalesce(with_check,'') ILIKE '%has_role(auth.uid()%admin%')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.payments', r.policyname);
  END LOOP;
END $$;

CREATE POLICY "Payment managers can view all payments" ON public.payments
  FOR SELECT TO authenticated USING (public.can_manage_payments(auth.uid()));
CREATE POLICY "Payment managers can insert payments" ON public.payments
  FOR INSERT TO authenticated WITH CHECK (public.can_manage_payments(auth.uid()));
CREATE POLICY "Payment managers can update payments" ON public.payments
  FOR UPDATE TO authenticated USING (public.can_manage_payments(auth.uid())) WITH CHECK (public.can_manage_payments(auth.uid()));
CREATE POLICY "Payment managers can delete payments" ON public.payments
  FOR DELETE TO authenticated USING (public.can_manage_payments(auth.uid()));

-- payment_verification_attempts
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT policyname FROM pg_policies
    WHERE schemaname='public' AND tablename='payment_verification_attempts'
      AND (coalesce(qual,'') ILIKE '%has_role(auth.uid()%admin%' OR coalesce(with_check,'') ILIKE '%has_role(auth.uid()%admin%')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.payment_verification_attempts', r.policyname);
  END LOOP;
END $$;

CREATE POLICY "Payment managers manage verification attempts"
  ON public.payment_verification_attempts FOR ALL TO authenticated
  USING (public.can_manage_payments(auth.uid()))
  WITH CHECK (public.can_manage_payments(auth.uid()));

-- payment_nudge_history
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT policyname FROM pg_policies
    WHERE schemaname='public' AND tablename='payment_nudge_history'
      AND (coalesce(qual,'') ILIKE '%has_role(auth.uid()%admin%' OR coalesce(with_check,'') ILIKE '%has_role(auth.uid()%admin%')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.payment_nudge_history', r.policyname);
  END LOOP;
END $$;

CREATE POLICY "Payment managers manage nudge history"
  ON public.payment_nudge_history FOR ALL TO authenticated
  USING (public.can_manage_payments(auth.uid()))
  WITH CHECK (public.can_manage_payments(auth.uid()));

-- discount_codes
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT policyname FROM pg_policies
    WHERE schemaname='public' AND tablename='discount_codes'
      AND (coalesce(qual,'') ILIKE '%has_role(auth.uid()%admin%' OR coalesce(with_check,'') ILIKE '%has_role(auth.uid()%admin%')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.discount_codes', r.policyname);
  END LOOP;
END $$;

CREATE POLICY "Discount managers view discount codes" ON public.discount_codes
  FOR SELECT TO authenticated USING (public.can_manage_discounts(auth.uid()));
CREATE POLICY "Discount managers insert discount codes" ON public.discount_codes
  FOR INSERT TO authenticated WITH CHECK (public.can_manage_discounts(auth.uid()));
CREATE POLICY "Discount managers update discount codes" ON public.discount_codes
  FOR UPDATE TO authenticated USING (public.can_manage_discounts(auth.uid())) WITH CHECK (public.can_manage_discounts(auth.uid()));
CREATE POLICY "Discount managers delete discount codes" ON public.discount_codes
  FOR DELETE TO authenticated USING (public.can_manage_discounts(auth.uid()));

-- discount_redemptions
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT policyname FROM pg_policies
    WHERE schemaname='public' AND tablename='discount_redemptions'
      AND (coalesce(qual,'') ILIKE '%has_role(auth.uid()%admin%' OR coalesce(with_check,'') ILIKE '%has_role(auth.uid()%admin%')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.discount_redemptions', r.policyname);
  END LOOP;
END $$;

CREATE POLICY "Discount managers view redemptions" ON public.discount_redemptions
  FOR SELECT TO authenticated USING (public.can_manage_discounts(auth.uid()));