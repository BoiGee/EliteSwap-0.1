DROP POLICY IF EXISTS "badges readable to authenticated" ON public.forum_badges;
CREATE POLICY "users read own badges" ON public.forum_badges
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR has_role('admin'::app_role));