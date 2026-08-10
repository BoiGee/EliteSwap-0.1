
-- 1) Protect profiles funnel/nudge fields
CREATE OR REPLACE FUNCTION public.tg_profiles_guard_funnel()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (NEW.payment_funnel_stage IS DISTINCT FROM OLD.payment_funnel_stage
      OR NEW.last_payment_nudge_sent_at IS DISTINCT FROM OLD.last_payment_nudge_sent_at
      OR NEW.payment_funnel_updated_at IS DISTINCT FROM OLD.payment_funnel_updated_at
      OR NEW.email IS DISTINCT FROM OLD.email
      OR NEW.user_id IS DISTINCT FROM OLD.user_id)
     AND NOT public.has_role('admin'::app_role)
     AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Not allowed to modify protected profile fields' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_profiles_guard_funnel ON public.profiles;
CREATE TRIGGER trg_profiles_guard_funnel
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.tg_profiles_guard_funnel();

-- 2) Prevent users from re-approving their own reviews
CREATE OR REPLACE FUNCTION public.tg_reviews_block_approval_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (NEW.is_approved IS DISTINCT FROM OLD.is_approved
      OR NEW.user_id IS DISTINCT FROM OLD.user_id)
     AND NOT public.has_role('admin'::app_role)
     AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_reviews_block_approval_change ON public.reviews;
CREATE TRIGGER trg_reviews_block_approval_change
  BEFORE UPDATE ON public.reviews
  FOR EACH ROW EXECUTE FUNCTION public.tg_reviews_block_approval_change();

-- 3) Restrict support_messages.file_url to project storage domain
ALTER TABLE public.support_messages
  DROP CONSTRAINT IF EXISTS chk_file_url_domain;
ALTER TABLE public.support_messages
  ADD CONSTRAINT chk_file_url_domain CHECK (
    file_url IS NULL
    OR file_url LIKE 'https://clxdvyeumnvmalxbymwh.supabase.co/storage/%'
  );

-- 4) Recreate reviews_public view as SECURITY INVOKER
DROP VIEW IF EXISTS public.reviews_public;
CREATE VIEW public.reviews_public
WITH (security_invoker = true) AS
SELECT r.id,
  r.display_name,
  CASE
    WHEN (r.display_name IS NOT NULL AND length(trim(both from r.display_name)) > 0) THEN split_part(trim(both from r.display_name), ' '::text, 1)
    WHEN (p.email IS NOT NULL AND length(trim(both from p.email)) > 0) THEN split_part(p.email, '@'::text, 1)
    ELSE 'Anonymous'::text
  END AS public_name,
  r.rating, r.remark, r.is_approved, r.created_at, r.updated_at
FROM public.reviews r
LEFT JOIN public.profiles p ON p.user_id = r.user_id
WHERE r.is_approved = true;

GRANT SELECT ON public.reviews_public TO anon, authenticated;

-- Allow public to read approved reviews via the invoker view
DROP POLICY IF EXISTS "Anyone can view approved reviews" ON public.reviews;
CREATE POLICY "Anyone can view approved reviews"
ON public.reviews FOR SELECT
TO anon, authenticated
USING (is_approved = true);

-- Allow public read of minimal profile fields needed by the view (email for fallback name)
-- Restrict by only allowing when referenced via approved review join is hard; instead expose nothing extra:
-- Keep profiles RLS as-is. The view will return NULL email fallback for anon/auth without profile access,
-- in which case 'Anonymous' is returned. That's acceptable.
