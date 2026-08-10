
DROP POLICY IF EXISTS "author manages thread tags" ON public.forum_thread_tags;

CREATE POLICY "authors add tags to own threads"
ON public.forum_thread_tags
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.forum_threads t
    WHERE t.id = forum_thread_tags.thread_id
      AND t.author_id = auth.uid()
  )
);
