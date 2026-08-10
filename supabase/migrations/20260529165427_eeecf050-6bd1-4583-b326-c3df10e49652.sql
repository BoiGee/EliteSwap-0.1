-- Stop exposing reviews.user_id to all authenticated users.
-- Public reads already go through the reviews_public view (no user_id).
-- Authenticated users only need direct access to their own rows.
DROP POLICY IF EXISTS "Authenticated can view approved reviews" ON public.reviews;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='reviews' AND policyname='Users can view own reviews'
  ) THEN
    CREATE POLICY "Users can view own reviews"
      ON public.reviews
      FOR SELECT
      TO authenticated
      USING (auth.uid() = user_id);
  END IF;
END $$;