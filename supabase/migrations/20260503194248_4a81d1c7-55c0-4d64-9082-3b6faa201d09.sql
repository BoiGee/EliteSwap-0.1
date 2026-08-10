-- 1. Remove broad chat-attachments INSERT policy
DROP POLICY IF EXISTS "Authenticated users can upload chat files" ON storage.objects;

-- 2. Add scoped DELETE/UPDATE policies for chat-attachments
CREATE POLICY "Users can delete own chat files"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'chat-attachments' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can update own chat files"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'chat-attachments' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Admins can manage chat files"
ON storage.objects FOR ALL TO authenticated
USING (bucket_id = 'chat-attachments' AND public.has_role('admin'::app_role))
WITH CHECK (bucket_id = 'chat-attachments' AND public.has_role('admin'::app_role));

-- 3. Revoke anon SELECT on reviews.user_id (re-grant other columns)
REVOKE SELECT ON public.reviews FROM anon;
GRANT SELECT (id, created_at, updated_at, is_approved, remark, rating, display_name) ON public.reviews TO anon;

-- 4. Add owner SELECT policy for free_trial_keys
CREATE POLICY "Users can view own claimed trial keys"
ON public.free_trial_keys FOR SELECT TO authenticated
USING (auth.uid() = claimed_by_user_id);