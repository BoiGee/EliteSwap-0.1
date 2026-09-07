-- Support report: uploading a file in the admin dashboard's Support tab
-- fails with "Upload failed". Root cause: the chat-attachments storage
-- policies only recognize the 'admin' role via has_role('admin'::app_role)
-- — but Admin.tsx explicitly grants 'moderator' and 'sec_admin' staff
-- access to the Support tab too ("Base moderator tabs (read-only +
-- forum/support)"). SupportChatManager.tsx also uploads every staff
-- attachment under the literal path "admin/<timestamp>.<ext>" regardless
-- of who's actually uploading, so it never matches the owner-folder
-- branch either (auth.uid()::text = (storage.foldername(name))[1]).
-- Net effect: any moderator or sec_admin replying with an attachment gets
-- denied by RLS, while a true 'admin' role account works fine — matching
-- a report of admin-dashboard uploads failing without it being universal.
--
-- The customer-facing widget (SupportChat.tsx) uploads to
-- "<user.id>/<timestamp>.<ext>", which always matches the owner-folder
-- branch regardless of role, so regular end users were never affected.
--
-- Fix: swap the admin-only has_role('admin') checks for public.is_staff()
-- (admin OR moderator OR sec_admin — the same helper already used for
-- forum_user_sanctions), so every role actually permitted to use the
-- Support tab can also attach files there.

DROP POLICY IF EXISTS "Users can view own chat files" ON storage.objects;
CREATE POLICY "Users can view own chat files"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'chat-attachments'
  AND (
    auth.uid()::text = (storage.foldername(name))[1]
    OR public.is_staff(auth.uid())
  )
);

DROP POLICY IF EXISTS "Users can upload to own chat folder" ON storage.objects;
CREATE POLICY "Users can upload to own chat folder"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'chat-attachments'
  AND (
    auth.uid()::text = (storage.foldername(name))[1]
    OR public.is_staff(auth.uid())
  )
);

DROP POLICY IF EXISTS "Admins can manage chat files" ON storage.objects;
CREATE POLICY "Staff can manage chat files"
ON storage.objects FOR ALL TO authenticated
USING (bucket_id = 'chat-attachments' AND public.is_staff(auth.uid()))
WITH CHECK (bucket_id = 'chat-attachments' AND public.is_staff(auth.uid()));
