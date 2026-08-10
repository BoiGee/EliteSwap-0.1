DROP POLICY IF EXISTS "owners insert media" ON public.forum_media;

CREATE POLICY "owners insert media"
ON public.forum_media
FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = owner_id
  AND status = 'pending'::forum_media_status
  AND (
    (thread_id IS NOT NULL AND reply_id IS NULL AND EXISTS (
      SELECT 1 FROM public.forum_threads t
      WHERE t.id = forum_media.thread_id AND t.author_id = auth.uid()
    ))
    OR
    (reply_id IS NOT NULL AND thread_id IS NULL AND EXISTS (
      SELECT 1 FROM public.forum_replies r
      WHERE r.id = forum_media.reply_id AND r.author_id = auth.uid()
    ))
  )
);