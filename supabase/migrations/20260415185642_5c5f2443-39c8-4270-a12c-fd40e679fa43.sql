
-- payments
ALTER POLICY "Users can view own payments" ON public.payments TO authenticated;
ALTER POLICY "Users can insert own payments" ON public.payments TO authenticated;
ALTER POLICY "Admins can view all payments" ON public.payments TO authenticated;
ALTER POLICY "Admins can update payments" ON public.payments TO authenticated;

-- api_keys
ALTER POLICY "Users can view own api_keys" ON public.api_keys TO authenticated;
ALTER POLICY "Users can insert own api_keys" ON public.api_keys TO authenticated;
ALTER POLICY "Users can update own api_keys" ON public.api_keys TO authenticated;
ALTER POLICY "Admins can view all api_keys" ON public.api_keys TO authenticated;
ALTER POLICY "Admins can update api_keys" ON public.api_keys TO authenticated;
ALTER POLICY "Admins can delete api_keys" ON public.api_keys TO authenticated;

-- profiles
ALTER POLICY "Users can view own profile" ON public.profiles TO authenticated;
ALTER POLICY "Users can insert own profile" ON public.profiles TO authenticated;
ALTER POLICY "Users can update own profile" ON public.profiles TO authenticated;
ALTER POLICY "Admins can view all profiles" ON public.profiles TO authenticated;

-- user_roles
ALTER POLICY "Admins can view all roles" ON public.user_roles TO authenticated;
ALTER POLICY "Admins can insert roles" ON public.user_roles TO authenticated;
ALTER POLICY "Admins can delete roles" ON public.user_roles TO authenticated;
