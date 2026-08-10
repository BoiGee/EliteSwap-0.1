CREATE OR REPLACE FUNCTION public.tg_mirror_forum_notifications()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_title text;
  v_href text;
  v_thread_id uuid;
BEGIN
  v_title := CASE NEW.kind
    WHEN 'reply' THEN 'New reply to your thread'
    WHEN 'mention' THEN 'You were mentioned'
    WHEN 'solution' THEN 'Your reply was marked as solution'
    WHEN 'media_approved' THEN 'Your media was approved'
    WHEN 'media_rejected' THEN 'Your media was rejected'
    WHEN 'report_resolved' THEN 'A report you filed was reviewed'
    ELSE 'Community update'
  END;

  -- Resolve thread id for deep-link
  IF NEW.target_kind::text = 'thread' AND NEW.target_id IS NOT NULL THEN
    v_thread_id := NEW.target_id;
  ELSIF (NEW.data->>'thread_id') IS NOT NULL THEN
    v_thread_id := (NEW.data->>'thread_id')::uuid;
  ELSIF NEW.target_kind::text = 'reply' AND NEW.target_id IS NOT NULL THEN
    SELECT thread_id INTO v_thread_id FROM public.forum_replies WHERE id = NEW.target_id;
  END IF;

  v_href := CASE
    WHEN v_thread_id IS NOT NULL THEN '/forum/t/' || v_thread_id::text
    ELSE '/forum/me'
  END;

  INSERT INTO public.app_notifications
    (user_id, category, kind, severity, title, body, href, target_kind, target_id, actor_id, data)
  VALUES (
    NEW.user_id, 'forum', 'forum_' || NEW.kind, 'info', v_title,
    COALESCE(NEW.data->>'thread_title', NULL),
    v_href, NEW.target_kind::text, NEW.target_id, NEW.actor_id, NEW.data
  )
  ON CONFLICT (user_id, kind, target_id) WHERE target_id IS NOT NULL DO NOTHING;
  RETURN NEW;
END $function$;