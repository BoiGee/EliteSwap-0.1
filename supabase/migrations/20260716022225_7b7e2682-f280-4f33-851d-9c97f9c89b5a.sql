
DROP POLICY IF EXISTS "Users manage own push subs" ON public.admin_push_subscriptions;

CREATE POLICY "Admins manage own push subs"
ON public.admin_push_subscriptions
FOR ALL
TO authenticated
USING (auth.uid() = user_id AND public.has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (auth.uid() = user_id AND public.has_role(auth.uid(), 'admin'::app_role));
