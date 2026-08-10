
-- 1) forum_user_stats: stop exposing banned_reason/banned_at to the banned user.
-- Drop the direct owner SELECT policy; owners now read via SECURITY DEFINER view.
DROP POLICY IF EXISTS "users read own stats sans ban" ON public.forum_user_stats;

-- Rebuild owner-facing view as SECURITY DEFINER so it works without an owner RLS policy.
DROP VIEW IF EXISTS public.my_forum_stats;
CREATE VIEW public.my_forum_stats
WITH (security_invoker = false) AS
SELECT
  user_id,
  reputation,
  threads_count,
  replies_count,
  solutions_count,
  last_post_at,
  is_banned,
  updated_at
FROM public.forum_user_stats
WHERE user_id = auth.uid();
GRANT SELECT ON public.my_forum_stats TO authenticated;

-- 2) Public-facing forum stats (reputation, post counts) for community UI.
-- Excludes ban fields. SECURITY DEFINER bypasses RLS for these non-sensitive columns only.
CREATE OR REPLACE VIEW public.forum_public_stats
WITH (security_invoker = false) AS
SELECT
  user_id,
  reputation,
  threads_count,
  replies_count,
  solutions_count,
  last_post_at
FROM public.forum_user_stats;
GRANT SELECT ON public.forum_public_stats TO anon, authenticated;

-- 3) payment_verification_attempts: let users see their own attempts.
CREATE POLICY "users read own verification attempts"
  ON public.payment_verification_attempts
  FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.payments p
    WHERE p.id = payment_verification_attempts.payment_id
      AND p.user_id = auth.uid()
  ));
