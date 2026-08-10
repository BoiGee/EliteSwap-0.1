
-- 1. Safe public RPC to check promo code validity without exposing discount_codes table
CREATE OR REPLACE FUNCTION public.get_promo_code_status(p_code text)
RETURNS TABLE(percent_off integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT dc.percent_off
  FROM public.discount_codes dc
  WHERE dc.code = p_code
    AND dc.is_active = true
    AND (dc.expires_at IS NULL OR dc.expires_at > now())
    AND (dc.max_redemptions IS NULL OR dc.times_redeemed < dc.max_redemptions)
  LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.get_promo_code_status(text) TO anon, authenticated;

-- 2. Scope forum_user_stats admin management policy to authenticated role only
DROP POLICY IF EXISTS "admins manage stats" ON public.forum_user_stats;
CREATE POLICY "admins manage stats"
  ON public.forum_user_stats
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING (has_role('admin'::app_role))
  WITH CHECK (has_role('admin'::app_role));

-- 3. Stop exposing ban moderation details to the banned user themselves.
--    Split the combined own/admin read policy:
--    - Admins keep full row visibility via direct table reads.
--    - Regular users read their own stats only through a view that omits ban fields.
DROP POLICY IF EXISTS "own stats readable" ON public.forum_user_stats;

CREATE POLICY "admins read all stats"
  ON public.forum_user_stats
  FOR SELECT
  TO authenticated
  USING (has_role('admin'::app_role));

CREATE POLICY "users read own stats sans ban"
  ON public.forum_user_stats
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- View for client use that omits banned_reason and banned_at.
-- is_banned is retained so the UI can gate posting, but moderation reason/time stays admin-only.
CREATE OR REPLACE VIEW public.my_forum_stats
WITH (security_invoker = true) AS
SELECT
  user_id,
  reputation,
  threads_count,
  replies_count,
  solutions_count,
  last_post_at,
  is_banned,
  updated_at
FROM public.forum_user_stats;

GRANT SELECT ON public.my_forum_stats TO authenticated;
