
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS preferred_language text;

CREATE TABLE IF NOT EXISTS public.translation_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_hash text NOT NULL,
  target_lang text NOT NULL,
  source_lang text NOT NULL DEFAULT 'en',
  source_text text NOT NULL,
  translated_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  hit_count integer NOT NULL DEFAULT 0,
  UNIQUE (source_hash, target_lang)
);

GRANT SELECT ON public.translation_cache TO anon, authenticated;
GRANT ALL ON public.translation_cache TO service_role;
ALTER TABLE public.translation_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "translation_cache readable by everyone"
ON public.translation_cache FOR SELECT
USING (true);

CREATE INDEX IF NOT EXISTS idx_translation_cache_lookup
  ON public.translation_cache (source_hash, target_lang);
