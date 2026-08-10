CREATE OR REPLACE FUNCTION public.is_email_confirmed(uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = uid AND email_confirmed_at IS NOT NULL
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_email_confirmed(uuid) TO authenticated;

DROP POLICY IF EXISTS "users create threads" ON public.forum_threads;
CREATE POLICY "users create threads" ON public.forum_threads
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = author_id
    AND NOT public.forum_is_banned(auth.uid())
    AND public.forum_can_view_category(category_id)
    AND public.is_email_confirmed(auth.uid())
    AND (posted_as_admin IS FALSE OR public.has_role(auth.uid(), 'admin'::app_role))
  );

DROP POLICY IF EXISTS "users create replies" ON public.forum_replies;
CREATE POLICY "users create replies" ON public.forum_replies
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = author_id
    AND NOT public.forum_is_banned(auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.forum_threads t
      WHERE t.id = forum_replies.thread_id
        AND NOT t.is_locked
        AND t.hidden_at IS NULL
        AND public.forum_can_view_category(t.category_id)
    )
    AND public.is_email_confirmed(auth.uid())
    AND (posted_as_admin IS FALSE OR public.has_role(auth.uid(), 'admin'::app_role))
  );