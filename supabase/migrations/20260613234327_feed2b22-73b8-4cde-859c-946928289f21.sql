
DROP POLICY IF EXISTS "Anyone can view active plans" ON public.pricing_plans;
-- Admin SELECT policy already exists; keep it.
-- Authenticated users have no need for raw table; they read via pricing_plans_public.
