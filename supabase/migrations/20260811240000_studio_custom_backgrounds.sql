-- Custom studio backgrounds: Professional/Enterprise-only feature letting a
-- user upload an image that replaces the background behind them in the live
-- Face Swap Output (and the OBS relay), plus a zero-cost chroma-key
-- ("green screen") mode as a free bonus for anyone with a physical screen.
-- All actual video compositing happens client-side (WebGL + a Web Worker
-- running MediaPipe's selfie-segmentation model); this migration only adds
-- the storage/metadata/gating backend.

-- 1) Plan-tier helpers — defined first since the storage policies below
--    reference user_has_pro_plan().
--
-- "has this user ever held a Professional/Enterprise key" (account-level,
-- permissive: once you've paid for Pro you keep the ability to manage
-- backgrounds even between key renewals). This gates uploading/managing
-- backgrounds. Actually USING a background in a live session is separately
-- gated client-side against the specific key in use for that session
-- (get_api_key_plan_tier below) — a Basic key never gets the feature
-- surfaced even if the account also owns a Pro key elsewhere.
CREATE OR REPLACE FUNCTION public.user_has_pro_plan(_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.api_keys k
    JOIN public.payments p ON p.id = k.payment_id
    JOIN public.pricing_plans pp ON pp.id = p.plan_id
    WHERE k.user_id = _user_id AND pp.name IN ('Professional', 'Enterprise')
  );
$$;
GRANT EXECUTE ON FUNCTION public.user_has_pro_plan(uuid) TO authenticated;

-- Read-only: which plan (if any) backs a specific key, for the studio UI to
-- decide whether to surface the background panel for the key actually in use.
CREATE OR REPLACE FUNCTION public.get_api_key_plan_tier(p_key text)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT pp.name
    FROM public.api_keys k
    LEFT JOIN public.payments p ON p.id = k.payment_id
    LEFT JOIN public.pricing_plans pp ON pp.id = p.plan_id
   WHERE k.key = trim(p_key) AND k.user_id = auth.uid()
   LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.get_api_key_plan_tier(text) TO authenticated;

-- 2) Storage bucket — private, owner-scoped, small (backgrounds are single
--    still images, not video), image-only.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('studio-backgrounds', 'studio-backgrounds', false, 8388608, ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO NOTHING;

-- Path convention: <user_id>/<filename> — folder-scoped ownership check.
CREATE POLICY "own studio background insert"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'studio-backgrounds'
  AND (storage.foldername(name))[1] = auth.uid()::text
  AND public.user_has_pro_plan(auth.uid())
);
CREATE POLICY "own studio background read"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'studio-backgrounds' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "own studio background delete"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'studio-backgrounds' AND (storage.foldername(name))[1] = auth.uid()::text);

-- 3) Metadata table.
CREATE TABLE public.studio_backgrounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  storage_path text NOT NULL,
  file_name text,
  file_size integer,
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_studio_backgrounds_user ON public.studio_backgrounds(user_id);
-- At most one active background per user.
CREATE UNIQUE INDEX idx_studio_backgrounds_one_active_per_user
  ON public.studio_backgrounds(user_id) WHERE is_active;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.studio_backgrounds TO authenticated;
GRANT ALL ON public.studio_backgrounds TO service_role;
ALTER TABLE public.studio_backgrounds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users manage own backgrounds"
ON public.studio_backgrounds FOR ALL TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id AND public.user_has_pro_plan(auth.uid()));

CREATE POLICY "staff view all backgrounds"
ON public.studio_backgrounds FOR SELECT TO authenticated
USING (public.is_staff(auth.uid()));

-- Atomically activate one background (deactivating any other) or, with a
-- null id, clear the active background entirely (plain output). Avoids the
-- client having to do a deactivate-then-activate two-step that could race
-- against the one-active-per-user unique index.
CREATE OR REPLACE FUNCTION public.set_active_studio_background(p_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;

  IF p_id IS NULL THEN
    UPDATE public.studio_backgrounds SET is_active = false WHERE user_id = auth.uid() AND is_active;
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.studio_backgrounds WHERE id = p_id AND user_id = auth.uid()) THEN
    RAISE EXCEPTION 'not found or not owner';
  END IF;

  UPDATE public.studio_backgrounds SET is_active = false WHERE user_id = auth.uid() AND is_active AND id <> p_id;
  UPDATE public.studio_backgrounds SET is_active = true WHERE id = p_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_active_studio_background(uuid) TO authenticated;

-- 4) Label the feature on the pricing page — Pricing.tsx / PricingSection.tsx
--    both render plan.features generically, so this is a pure data change.
UPDATE public.pricing_plans
   SET features = features || ARRAY['Custom Studio Background (AI or Green Screen)']
 WHERE name IN ('Professional', 'Enterprise')
   AND NOT ('Custom Studio Background (AI or Green Screen)' = ANY(features));
