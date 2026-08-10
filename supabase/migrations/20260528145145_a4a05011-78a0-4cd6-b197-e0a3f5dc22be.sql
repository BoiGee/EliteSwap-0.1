-- 1) Tighten api_keys UPDATE policy: users can only change `label`. All other
--    columns (including timer/session fields) must remain unchanged on user updates.
DROP POLICY IF EXISTS "Users can update own api_keys" ON public.api_keys;

CREATE POLICY "Users can update own api_keys"
ON public.api_keys
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (
  auth.uid() = user_id
  AND EXISTS (
    SELECT 1 FROM public.api_keys existing
    WHERE existing.id = api_keys.id
      AND existing.user_id              = api_keys.user_id
      AND existing.key                  = api_keys.key
      AND existing.is_active            IS NOT DISTINCT FROM api_keys.is_active
      AND existing.remaining_ms         IS NOT DISTINCT FROM api_keys.remaining_ms
      AND existing.expires_at           IS NOT DISTINCT FROM api_keys.expires_at
      AND existing.active_session_id    IS NOT DISTINCT FROM api_keys.active_session_id
      AND existing.active_session_started_at IS NOT DISTINCT FROM api_keys.active_session_started_at
      AND existing.last_session_ended_at IS NOT DISTINCT FROM api_keys.last_session_ended_at
      AND existing.created_at           IS NOT DISTINCT FROM api_keys.created_at
  )
);

-- 2) Stop exposing reviews.user_id to anonymous visitors.
--    Drop the broad public SELECT policy on the base table; public clients must
--    use the `reviews_public` view, which does not expose user_id.
DROP POLICY IF EXISTS "Anyone can view approved reviews" ON public.reviews;

-- Authenticated users can still see approved reviews via the base table if they
-- need to (e.g., self-check + admin-managed flows already covered by other policies).
-- We re-add an authenticated-only read of approved reviews so logged-in flows
-- (e.g., checking own review existence) keep working without leaking user_id to anon.
CREATE POLICY "Authenticated can view approved reviews"
ON public.reviews
FOR SELECT
TO authenticated
USING (is_approved = true);

-- Recreate reviews_public as a SECURITY DEFINER-style view (security_invoker=false)
-- so anon clients can read it without needing RLS access to the base table.
DROP VIEW IF EXISTS public.reviews_public;
CREATE VIEW public.reviews_public
WITH (security_invoker = false) AS
SELECT
  r.id,
  r.display_name,
  CASE
    WHEN r.display_name IS NOT NULL AND length(btrim(r.display_name)) > 0
      THEN split_part(btrim(r.display_name), ' ', 1)
    WHEN p.email IS NOT NULL AND length(btrim(p.email)) > 0
      THEN split_part(p.email, '@', 1)
    ELSE 'Anonymous'
  END AS public_name,
  r.rating,
  r.remark,
  r.is_approved,
  r.created_at,
  r.updated_at
FROM public.reviews r
LEFT JOIN public.profiles p ON p.user_id = r.user_id
WHERE r.is_approved = true;

GRANT SELECT ON public.reviews_public TO anon, authenticated;