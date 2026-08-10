
-- account_deletion_requests: allow users to insert their own
CREATE POLICY "Users insert own deletion request"
ON public.account_deletion_requests
FOR INSERT TO authenticated
WITH CHECK (auth.uid() = user_id);

-- announcement_views: allow users to insert/update their own
CREATE POLICY "Users insert own announcement views"
ON public.announcement_views
FOR INSERT TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own announcement views"
ON public.announcement_views
FOR UPDATE TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- forum_thread_views: allow users to insert/update their own
CREATE POLICY "Users insert own thread views"
ON public.forum_thread_views
FOR INSERT TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own thread views"
ON public.forum_thread_views
FOR UPDATE TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- forum_user_sanctions: staff can insert/update
CREATE POLICY "Staff insert sanctions"
ON public.forum_user_sanctions
FOR INSERT TO authenticated
WITH CHECK (public.is_staff(auth.uid()));

CREATE POLICY "Staff update sanctions"
ON public.forum_user_sanctions
FOR UPDATE TO authenticated
USING (public.is_staff(auth.uid()))
WITH CHECK (public.is_staff(auth.uid()));

-- pricing_plans: public can read active plans
GRANT SELECT ON public.pricing_plans TO anon;

CREATE POLICY "Public can view active plans"
ON public.pricing_plans
FOR SELECT TO anon, authenticated
USING (is_active = true);
