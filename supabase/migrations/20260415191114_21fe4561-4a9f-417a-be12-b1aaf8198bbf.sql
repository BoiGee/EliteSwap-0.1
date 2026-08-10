
-- Drop all policies that depend on has_role(uuid, app_role) first
DROP POLICY IF EXISTS "Admins can view all payments" ON public.payments;
DROP POLICY IF EXISTS "Admins can update payments" ON public.payments;
DROP POLICY IF EXISTS "Admins can view all api_keys" ON public.api_keys;
DROP POLICY IF EXISTS "Admins can update api_keys" ON public.api_keys;
DROP POLICY IF EXISTS "Admins can delete api_keys" ON public.api_keys;
DROP POLICY IF EXISTS "Admins can view all profiles" ON public.profiles;
DROP POLICY IF EXISTS "Admins can view all roles" ON public.user_roles;
DROP POLICY IF EXISTS "Admins can insert roles" ON public.user_roles;
DROP POLICY IF EXISTS "Admins can delete roles" ON public.user_roles;
DROP POLICY IF EXISTS "Admins can view all plans" ON public.pricing_plans;
DROP POLICY IF EXISTS "Admins can insert plans" ON public.pricing_plans;
DROP POLICY IF EXISTS "Admins can update plans" ON public.pricing_plans;
DROP POLICY IF EXISTS "Admins can delete plans" ON public.pricing_plans;

-- Now drop old function and create new one
DROP FUNCTION IF EXISTS public.has_role(uuid, app_role);

CREATE OR REPLACE FUNCTION public.has_role(_role app_role)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = _role
  )
$$;

-- Recreate all policies with new signature
CREATE POLICY "Admins can view all payments" ON public.payments FOR SELECT TO authenticated USING (has_role('admin'));
CREATE POLICY "Admins can update payments" ON public.payments FOR UPDATE TO authenticated USING (has_role('admin'));
CREATE POLICY "Admins can view all api_keys" ON public.api_keys FOR SELECT TO authenticated USING (has_role('admin'));
CREATE POLICY "Admins can update api_keys" ON public.api_keys FOR UPDATE TO authenticated USING (has_role('admin'));
CREATE POLICY "Admins can delete api_keys" ON public.api_keys FOR DELETE TO authenticated USING (has_role('admin'));
CREATE POLICY "Admins can view all profiles" ON public.profiles FOR SELECT TO authenticated USING (has_role('admin'));
CREATE POLICY "Admins can view all roles" ON public.user_roles FOR SELECT TO authenticated USING (has_role('admin'));
CREATE POLICY "Admins can insert roles" ON public.user_roles FOR INSERT TO authenticated WITH CHECK (has_role('admin'));
CREATE POLICY "Admins can delete roles" ON public.user_roles FOR DELETE TO authenticated USING (has_role('admin'));
CREATE POLICY "Admins can view all plans" ON public.pricing_plans FOR SELECT TO authenticated USING (has_role('admin'));
CREATE POLICY "Admins can insert plans" ON public.pricing_plans FOR INSERT TO authenticated WITH CHECK (has_role('admin'));
CREATE POLICY "Admins can update plans" ON public.pricing_plans FOR UPDATE TO authenticated USING (has_role('admin'));
CREATE POLICY "Admins can delete plans" ON public.pricing_plans FOR DELETE TO authenticated USING (has_role('admin'));
