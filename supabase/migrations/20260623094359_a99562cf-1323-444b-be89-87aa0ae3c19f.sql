
-- 1) forum_media: approved readable only by authenticated users
DROP POLICY IF EXISTS "approved media readable" ON public.forum_media;
CREATE POLICY "approved media readable"
ON public.forum_media
FOR SELECT
TO authenticated
USING (status = 'approved');

-- 2) forum_user_stats: restrict reads to owner + admin
DROP POLICY IF EXISTS "stats readable" ON public.forum_user_stats;
CREATE POLICY "own stats readable"
ON public.forum_user_stats
FOR SELECT
TO authenticated
USING (auth.uid() = user_id OR has_role('admin'::app_role));

-- 3) support_internal_notes: remove from realtime publication
ALTER PUBLICATION supabase_realtime DROP TABLE public.support_internal_notes;

-- 4) Storage SELECT policy: authenticated users can read forum-media objects
--    whose corresponding forum_media row is approved
CREATE POLICY "forum-media approved readable by authenticated"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'forum-media'
  AND EXISTS (
    SELECT 1 FROM public.forum_media fm
    WHERE fm.storage_path = storage.objects.name
      AND fm.status = 'approved'
  )
);
