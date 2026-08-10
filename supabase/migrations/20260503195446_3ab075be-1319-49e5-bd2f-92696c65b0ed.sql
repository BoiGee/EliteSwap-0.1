
-- Fix: Hide reviewer user_id from public/anonymous reads via a view.
CREATE OR REPLACE VIEW public.reviews_public AS
SELECT id, display_name, rating, remark, is_approved, created_at, updated_at
FROM public.reviews
WHERE is_approved = true;

GRANT SELECT ON public.reviews_public TO anon, authenticated;

-- Drop the broad "Anyone can view approved reviews" policy on the base table.
-- Public reads now go through reviews_public view (no user_id exposed).
-- Owners (auth.uid()=user_id) and admins still have policies on base table.
DROP POLICY IF EXISTS "Anyone can view approved reviews" ON public.reviews;

-- Add back a policy so authenticated users can still read approved reviews
-- on the base table when needed (admins/owners), but anon cannot.
-- Actually we want anon to NOT read base reviews at all (forces use of view).
REVOKE SELECT ON public.reviews FROM anon;
