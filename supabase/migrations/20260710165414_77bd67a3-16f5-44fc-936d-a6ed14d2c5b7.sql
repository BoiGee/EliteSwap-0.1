DROP POLICY IF EXISTS "translation_cache readable by everyone" ON public.translation_cache;
REVOKE SELECT ON public.translation_cache FROM anon, authenticated;
-- service_role bypasses RLS; edge function (translate-batch) uses service role key.
-- Purge any cached rows that look like PII (emails).
DELETE FROM public.translation_cache WHERE source_text ~* '[[:alnum:]._%+-]+@[[:alnum:].-]+\.[a-z]{2,}';