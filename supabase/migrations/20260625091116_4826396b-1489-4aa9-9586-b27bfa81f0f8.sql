
ALTER TABLE public.forum_threads ADD COLUMN IF NOT EXISTS posted_as_admin boolean NOT NULL DEFAULT false;
ALTER TABLE public.forum_replies ADD COLUMN IF NOT EXISTS posted_as_admin boolean NOT NULL DEFAULT false;

-- Replace user insert policies to forbid non-admins from setting posted_as_admin=true
DROP POLICY IF EXISTS "users create threads" ON public.forum_threads;
CREATE POLICY "users create threads" ON public.forum_threads
FOR INSERT TO authenticated
WITH CHECK (
  (auth.uid() = author_id)
  AND (NOT forum_is_banned(auth.uid()))
  AND forum_can_view_category(category_id)
  AND (EXISTS (SELECT 1 FROM auth.users WHERE users.id = auth.uid() AND users.email_confirmed_at IS NOT NULL))
  AND (posted_as_admin IS FALSE OR has_role(auth.uid(), 'admin'::app_role))
);

DROP POLICY IF EXISTS "users create replies" ON public.forum_replies;
CREATE POLICY "users create replies" ON public.forum_replies
FOR INSERT TO authenticated
WITH CHECK (
  (auth.uid() = author_id)
  AND (NOT forum_is_banned(auth.uid()))
  AND (EXISTS (SELECT 1 FROM public.forum_threads t WHERE t.id = forum_replies.thread_id AND NOT t.is_locked AND t.hidden_at IS NULL AND forum_can_view_category(t.category_id)))
  AND (EXISTS (SELECT 1 FROM auth.users WHERE users.id = auth.uid() AND users.email_confirmed_at IS NOT NULL))
  AND (posted_as_admin IS FALSE OR has_role(auth.uid(), 'admin'::app_role))
);
