
-- Storage policies for forum-media bucket. Path layout: {user_id}/{uuid}.{ext}
CREATE POLICY "forum-media owners upload" ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'forum-media'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

CREATE POLICY "forum-media owners read own" ON storage.objects FOR SELECT
  USING (
    bucket_id = 'forum-media'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

CREATE POLICY "forum-media owners delete own" ON storage.objects FOR DELETE
  USING (
    bucket_id = 'forum-media'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

CREATE POLICY "forum-media admins all" ON storage.objects FOR ALL
  USING (bucket_id = 'forum-media' AND public.has_role('admin'::app_role))
  WITH CHECK (bucket_id = 'forum-media' AND public.has_role('admin'::app_role));
