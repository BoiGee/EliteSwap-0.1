
-- 1. Make chat-attachments private and add ownership-scoped policies
UPDATE storage.buckets SET public = false WHERE id = 'chat-attachments';

DROP POLICY IF EXISTS "Anyone can view chat files" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated can upload chat files" ON storage.objects;

CREATE POLICY "Users can view own chat files"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'chat-attachments'
  AND (
    auth.uid()::text = (storage.foldername(name))[1]
    OR public.has_role('admin'::app_role)
  )
);

CREATE POLICY "Users can upload to own chat folder"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'chat-attachments'
  AND (
    auth.uid()::text = (storage.foldername(name))[1]
    OR public.has_role('admin'::app_role)
  )
);

-- 2. Restrict discount_codes: only admins can read directly; users use validate_discount_code RPC
DROP POLICY IF EXISTS "Authenticated can view active discount codes" ON public.discount_codes;

-- 3. Hide reviews.user_id from anonymous readers
REVOKE SELECT (user_id) ON public.reviews FROM anon;

-- 4. Set search_path on email queue functions to fix mutable search_path warnings
ALTER FUNCTION public.enqueue_email(text, jsonb) SET search_path = public, pgmq;
ALTER FUNCTION public.delete_email(text, bigint) SET search_path = public, pgmq;
ALTER FUNCTION public.read_email_batch(text, integer, integer) SET search_path = public, pgmq;
ALTER FUNCTION public.move_to_dlq(text, text, bigint, jsonb) SET search_path = public, pgmq;
