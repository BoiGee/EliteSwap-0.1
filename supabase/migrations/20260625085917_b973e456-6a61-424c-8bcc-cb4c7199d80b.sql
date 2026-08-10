
-- 1) Tighten forum_media table SELECT: must be approved AND viewer must have access to the category
DROP POLICY IF EXISTS "approved media readable" ON public.forum_media;
CREATE POLICY "approved media readable to category viewers"
ON public.forum_media
FOR SELECT
TO authenticated
USING (
  status = 'approved'
  AND (
    (thread_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.forum_threads t
      WHERE t.id = forum_media.thread_id
        AND public.forum_can_view_category(t.category_id)
    ))
    OR
    (reply_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.forum_replies r
      JOIN public.forum_threads t ON t.id = r.thread_id
      WHERE r.id = forum_media.reply_id
        AND public.forum_can_view_category(t.category_id)
    ))
  )
);

-- 2) Tighten storage SELECT for forum-media bucket with same category check
DROP POLICY IF EXISTS "forum-media approved readable by authenticated" ON storage.objects;
CREATE POLICY "forum-media approved readable to category viewers"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'forum-media'
  AND EXISTS (
    SELECT 1
    FROM public.forum_media fm
    LEFT JOIN public.forum_threads t1 ON t1.id = fm.thread_id
    LEFT JOIN public.forum_replies r ON r.id = fm.reply_id
    LEFT JOIN public.forum_threads t2 ON t2.id = r.thread_id
    WHERE fm.storage_path = storage.objects.name
      AND fm.status = 'approved'
      AND (
        (fm.thread_id IS NOT NULL AND public.forum_can_view_category(t1.category_id))
        OR
        (fm.reply_id IS NOT NULL AND public.forum_can_view_category(t2.category_id))
      )
  )
);
