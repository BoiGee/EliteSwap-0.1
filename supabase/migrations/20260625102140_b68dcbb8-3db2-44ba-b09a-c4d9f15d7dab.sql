
-- announcement_views
CREATE TABLE public.announcement_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  announcement_id uuid NOT NULL REFERENCES public.system_announcements(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  first_viewed_at timestamptz NOT NULL DEFAULT now(),
  last_viewed_at timestamptz NOT NULL DEFAULT now(),
  view_count integer NOT NULL DEFAULT 1,
  UNIQUE (announcement_id, user_id)
);

GRANT SELECT ON public.announcement_views TO authenticated;
GRANT ALL ON public.announcement_views TO service_role;

ALTER TABLE public.announcement_views ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can see their own announcement views"
  ON public.announcement_views FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Admins and moderators can view all announcement views"
  ON public.announcement_views FOR SELECT TO authenticated
  USING (public.has_role('admin'::app_role) OR public.has_role('moderator'::app_role));

CREATE INDEX idx_announcement_views_announcement ON public.announcement_views(announcement_id);
CREATE INDEX idx_announcement_views_user ON public.announcement_views(user_id);

-- forum_thread_views
CREATE TABLE public.forum_thread_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES public.forum_threads(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  first_viewed_at timestamptz NOT NULL DEFAULT now(),
  last_viewed_at timestamptz NOT NULL DEFAULT now(),
  view_count integer NOT NULL DEFAULT 1,
  UNIQUE (thread_id, user_id)
);

GRANT SELECT ON public.forum_thread_views TO authenticated;
GRANT ALL ON public.forum_thread_views TO service_role;

ALTER TABLE public.forum_thread_views ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can see their own thread views"
  ON public.forum_thread_views FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Admins and moderators can view all thread views"
  ON public.forum_thread_views FOR SELECT TO authenticated
  USING (public.has_role('admin'::app_role) OR public.has_role('moderator'::app_role));

CREATE INDEX idx_forum_thread_views_thread ON public.forum_thread_views(thread_id);
CREATE INDEX idx_forum_thread_views_user ON public.forum_thread_views(user_id);

-- Record functions (security definer = bypass RLS for writes)
CREATE OR REPLACE FUNCTION public.record_announcement_view(p_announcement_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO public.announcement_views (announcement_id, user_id)
  VALUES (p_announcement_id, v_uid)
  ON CONFLICT (announcement_id, user_id) DO UPDATE
    SET view_count = public.announcement_views.view_count + 1,
        last_viewed_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.record_thread_view(p_thread_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO public.forum_thread_views (thread_id, user_id)
  VALUES (p_thread_id, v_uid)
  ON CONFLICT (thread_id, user_id) DO UPDATE
    SET view_count = public.forum_thread_views.view_count + 1,
        last_viewed_at = now();
END;
$$;

-- Admin viewer listings
CREATE OR REPLACE FUNCTION public.admin_list_announcement_viewers(p_announcement_id uuid)
RETURNS TABLE (
  user_id uuid,
  email text,
  display_name text,
  first_viewed_at timestamptz,
  last_viewed_at timestamptz,
  view_count integer
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (public.has_role('admin'::app_role) OR public.has_role('moderator'::app_role)) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT v.user_id,
         p.email,
         p.display_name,
         v.first_viewed_at,
         v.last_viewed_at,
         v.view_count
  FROM public.announcement_views v
  LEFT JOIN public.profiles p ON p.user_id = v.user_id
  WHERE v.announcement_id = p_announcement_id
  ORDER BY v.last_viewed_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_list_thread_viewers(p_thread_id uuid)
RETURNS TABLE (
  user_id uuid,
  email text,
  display_name text,
  first_viewed_at timestamptz,
  last_viewed_at timestamptz,
  view_count integer
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (public.has_role('admin'::app_role) OR public.has_role('moderator'::app_role)) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT v.user_id,
         p.email,
         p.display_name,
         v.first_viewed_at,
         v.last_viewed_at,
         v.view_count
  FROM public.forum_thread_views v
  LEFT JOIN public.profiles p ON p.user_id = v.user_id
  WHERE v.thread_id = p_thread_id
  ORDER BY v.last_viewed_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_announcement_view_summary()
RETURNS TABLE (
  announcement_id uuid,
  unique_viewers integer,
  total_views bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (public.has_role('admin'::app_role) OR public.has_role('moderator'::app_role)) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT v.announcement_id,
         COUNT(DISTINCT v.user_id)::int,
         COALESCE(SUM(v.view_count), 0)::bigint
  FROM public.announcement_views v
  GROUP BY v.announcement_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_thread_view_summary()
RETURNS TABLE (
  thread_id uuid,
  unique_viewers integer,
  total_views bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (public.has_role('admin'::app_role) OR public.has_role('moderator'::app_role)) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT v.thread_id,
         COUNT(DISTINCT v.user_id)::int,
         COALESCE(SUM(v.view_count), 0)::bigint
  FROM public.forum_thread_views v
  GROUP BY v.thread_id;
END;
$$;
