
DROP VIEW IF EXISTS public.reviews_public;

CREATE VIEW public.reviews_public
WITH (security_invoker = true)
AS
SELECT
  r.id,
  r.display_name,
  CASE
    WHEN r.display_name IS NOT NULL AND length(trim(r.display_name)) > 0
      THEN split_part(trim(r.display_name), ' ', 1)
    WHEN p.email IS NOT NULL AND length(trim(p.email)) > 0
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
