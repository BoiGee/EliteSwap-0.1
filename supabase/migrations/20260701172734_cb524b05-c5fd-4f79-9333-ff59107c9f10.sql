
ALTER FUNCTION public.delete_email(text, bigint) SET search_path = public, pgmq;
ALTER FUNCTION public.enqueue_email(text, jsonb) SET search_path = public, pgmq;
ALTER FUNCTION public.move_to_dlq(text, text, bigint, jsonb) SET search_path = public, pgmq;
ALTER FUNCTION public.read_email_batch(text, integer, integer) SET search_path = public, pgmq;

DROP POLICY IF EXISTS "badges readable" ON public.forum_badges;
CREATE POLICY "badges readable to authenticated"
ON public.forum_badges
FOR SELECT
TO authenticated
USING (true);

REVOKE SELECT ON public.forum_badges FROM anon;
