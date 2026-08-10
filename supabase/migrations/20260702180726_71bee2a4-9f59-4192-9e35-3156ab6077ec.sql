
-- Tighten forum_tags read
DROP POLICY IF EXISTS "tags readable" ON public.forum_tags;
CREATE POLICY "tags readable to authenticated" ON public.forum_tags
  FOR SELECT TO authenticated USING (true);

-- Tighten forum_badges read (was already authenticated-only via role, keep explicit)
DROP POLICY IF EXISTS "badges readable to authenticated" ON public.forum_badges;
CREATE POLICY "badges readable to authenticated" ON public.forum_badges
  FOR SELECT TO authenticated USING (true);

-- Restrict forum_thread_tags visibility to threads the user can view
DROP POLICY IF EXISTS "thread_tags readable" ON public.forum_thread_tags;
CREATE POLICY "thread_tags readable when thread visible" ON public.forum_thread_tags
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.forum_threads t
      WHERE t.id = forum_thread_tags.thread_id
        AND t.hidden_at IS NULL
        AND public.forum_can_view_category(t.category_id)
    )
  );

-- Fix mutable search_path on email queue functions
ALTER FUNCTION public.read_email_batch(text, integer, integer) SET search_path = pgmq, public;
ALTER FUNCTION public.delete_email(text, bigint) SET search_path = pgmq, public;
ALTER FUNCTION public.move_to_dlq(text, text, bigint, jsonb) SET search_path = pgmq, public;
ALTER FUNCTION public.enqueue_email(text, jsonb) SET search_path = pgmq, public;
