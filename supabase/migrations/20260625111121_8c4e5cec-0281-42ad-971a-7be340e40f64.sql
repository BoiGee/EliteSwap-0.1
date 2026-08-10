
-- 1) Helper: is_staff
CREATE OR REPLACE FUNCTION public.is_staff(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_role(_user_id, 'admin'::app_role)
      OR public.has_role(_user_id, 'moderator'::app_role);
$$;

-- Convenience overload reading auth.uid()
CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_staff(auth.uid());
$$;

-- 2) forum_user_sanctions table
DO $$ BEGIN
  CREATE TYPE public.forum_sanction_type AS ENUM ('warn','mute','ban');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.forum_user_sanctions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  type public.forum_sanction_type NOT NULL,
  reason text,
  expires_at timestamptz,
  issued_by uuid,
  lifted_at timestamptz,
  lifted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_forum_user_sanctions_user_active
  ON public.forum_user_sanctions(user_id)
  WHERE lifted_at IS NULL;

GRANT SELECT ON public.forum_user_sanctions TO authenticated;
GRANT ALL ON public.forum_user_sanctions TO service_role;

ALTER TABLE public.forum_user_sanctions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users see own sanctions" ON public.forum_user_sanctions;
CREATE POLICY "Users see own sanctions" ON public.forum_user_sanctions
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Staff see all sanctions" ON public.forum_user_sanctions;
CREATE POLICY "Staff see all sanctions" ON public.forum_user_sanctions
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

-- Writes go through RPCs (service-role only via SECURITY DEFINER)

-- 3) Extend forum_is_banned to also honor active sanctions (ban or mute)
CREATE OR REPLACE FUNCTION public.forum_is_banned(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE((SELECT is_banned FROM public.forum_user_stats WHERE user_id = _user_id), false)
    OR EXISTS (
      SELECT 1 FROM public.forum_user_sanctions s
      WHERE s.user_id = _user_id
        AND s.type IN ('ban','mute')
        AND s.lifted_at IS NULL
        AND (s.expires_at IS NULL OR s.expires_at > now())
    );
$$;

-- 4) RLS updates: extend admin policies to staff (admin + moderator) for read/manage that moderators are allowed.

-- forum_threads
DROP POLICY IF EXISTS "admins read all threads" ON public.forum_threads;
CREATE POLICY "staff read all threads" ON public.forum_threads
  FOR SELECT USING (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS "admins manage threads" ON public.forum_threads;
CREATE POLICY "staff manage threads" ON public.forum_threads
  FOR ALL USING (public.is_staff(auth.uid()))
  WITH CHECK (public.is_staff(auth.uid()));

-- forum_replies
DROP POLICY IF EXISTS "admins read all replies" ON public.forum_replies;
CREATE POLICY "staff read all replies" ON public.forum_replies
  FOR SELECT USING (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS "admins manage replies" ON public.forum_replies;
CREATE POLICY "staff manage replies" ON public.forum_replies
  FOR ALL USING (public.is_staff(auth.uid()))
  WITH CHECK (public.is_staff(auth.uid()));

-- forum_media
DROP POLICY IF EXISTS "admins see all media" ON public.forum_media;
CREATE POLICY "staff see all media" ON public.forum_media
  FOR SELECT USING (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS "admins manage media" ON public.forum_media;
CREATE POLICY "staff manage media" ON public.forum_media
  FOR ALL USING (public.is_staff(auth.uid()))
  WITH CHECK (public.is_staff(auth.uid()));

-- forum_reports
DROP POLICY IF EXISTS "admins manage reports" ON public.forum_reports;
CREATE POLICY "staff manage reports" ON public.forum_reports
  FOR ALL USING (public.is_staff(auth.uid()))
  WITH CHECK (public.is_staff(auth.uid()));

-- forum_thread_tags: moderators can delete tags too (admin already had ALL via prior policy)
DROP POLICY IF EXISTS "admins manage thread tags" ON public.forum_thread_tags;
CREATE POLICY "staff manage thread tags" ON public.forum_thread_tags
  FOR ALL USING (public.is_staff(auth.uid()))
  WITH CHECK (public.is_staff(auth.uid()));

-- forum_user_stats: allow staff to read stats (needed to see who's banned, etc.)
DROP POLICY IF EXISTS "Admins view all user stats" ON public.forum_user_stats;
CREATE POLICY "Staff view all user stats" ON public.forum_user_stats
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

-- support_conversations
DROP POLICY IF EXISTS "Admins can view all conversations" ON public.support_conversations;
CREATE POLICY "Staff can view all conversations" ON public.support_conversations
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS "Admins can update conversations" ON public.support_conversations;
CREATE POLICY "Staff can update conversations" ON public.support_conversations
  FOR UPDATE TO authenticated USING (public.is_staff(auth.uid())) WITH CHECK (public.is_staff(auth.uid()));

-- support_messages
DROP POLICY IF EXISTS "Admins can view all messages" ON public.support_messages;
CREATE POLICY "Staff can view all messages" ON public.support_messages
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS "Admins can insert messages" ON public.support_messages;
CREATE POLICY "Staff can insert messages" ON public.support_messages
  FOR INSERT TO authenticated WITH CHECK (public.is_staff(auth.uid()));

-- support_internal_notes (read + insert for staff, update/delete admin-only)
DROP POLICY IF EXISTS "Admins view internal notes" ON public.support_internal_notes;
CREATE POLICY "Staff view internal notes" ON public.support_internal_notes
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS "Admins insert internal notes" ON public.support_internal_notes;
CREATE POLICY "Staff insert internal notes" ON public.support_internal_notes
  FOR INSERT TO authenticated WITH CHECK (public.is_staff(auth.uid()) AND auth.uid() = author_id);

-- studio_sessions: staff read
DROP POLICY IF EXISTS "Admins can view all studio sessions" ON public.studio_sessions;
CREATE POLICY "Staff can view all studio sessions" ON public.studio_sessions
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

-- user_activity_logs: staff read
DROP POLICY IF EXISTS "Admins can view all activity" ON public.user_activity_logs;
CREATE POLICY "Staff can view all activity" ON public.user_activity_logs
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

-- system_announcements: staff read (mods read-only); admin retains create/update/delete
DROP POLICY IF EXISTS "Admins view all announcements" ON public.system_announcements;
CREATE POLICY "Staff view all announcements" ON public.system_announcements
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

-- profiles: staff read-only access for user lookup
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy WHERE polname = 'Staff can view all profiles' AND polrelid = 'public.profiles'::regclass
  ) THEN
    EXECUTE 'CREATE POLICY "Staff can view all profiles" ON public.profiles FOR SELECT TO authenticated USING (public.is_staff(auth.uid()))';
  END IF;
END $$;

-- 5) Moderator RPCs (SECURITY DEFINER)

CREATE OR REPLACE FUNCTION public.mod_set_thread_flags(
  p_thread_id uuid,
  p_is_pinned boolean DEFAULT NULL,
  p_is_locked boolean DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_staff(auth.uid()) THEN RAISE EXCEPTION 'not authorized'; END IF;
  UPDATE public.forum_threads
     SET is_pinned = COALESCE(p_is_pinned, is_pinned),
         is_locked = COALESCE(p_is_locked, is_locked),
         updated_at = now()
   WHERE id = p_thread_id;
END $$;
GRANT EXECUTE ON FUNCTION public.mod_set_thread_flags(uuid, boolean, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.mod_hide_thread(p_thread_id uuid, p_hide boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_staff(auth.uid()) THEN RAISE EXCEPTION 'not authorized'; END IF;
  UPDATE public.forum_threads
     SET hidden_at = CASE WHEN p_hide THEN now() ELSE NULL END,
         updated_at = now()
   WHERE id = p_thread_id;
END $$;
GRANT EXECUTE ON FUNCTION public.mod_hide_thread(uuid, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.mod_hide_reply(p_reply_id uuid, p_hide boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_staff(auth.uid()) THEN RAISE EXCEPTION 'not authorized'; END IF;
  UPDATE public.forum_replies
     SET hidden_at = CASE WHEN p_hide THEN now() ELSE NULL END,
         updated_at = now()
   WHERE id = p_reply_id;
END $$;
GRANT EXECUTE ON FUNCTION public.mod_hide_reply(uuid, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.mod_delete_thread(p_thread_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_staff(auth.uid()) THEN RAISE EXCEPTION 'not authorized'; END IF;
  DELETE FROM public.forum_threads WHERE id = p_thread_id;
END $$;
GRANT EXECUTE ON FUNCTION public.mod_delete_thread(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.mod_delete_reply(p_reply_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_staff(auth.uid()) THEN RAISE EXCEPTION 'not authorized'; END IF;
  DELETE FROM public.forum_replies WHERE id = p_reply_id;
END $$;
GRANT EXECUTE ON FUNCTION public.mod_delete_reply(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.mod_resolve_report(p_report_id uuid, p_status text, p_notes text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_staff(auth.uid()) THEN RAISE EXCEPTION 'not authorized'; END IF;
  IF p_status NOT IN ('resolved','dismissed','open') THEN RAISE EXCEPTION 'invalid status'; END IF;
  UPDATE public.forum_reports
     SET status = p_status,
         resolved_at = CASE WHEN p_status IN ('resolved','dismissed') THEN now() ELSE NULL END,
         resolved_by = CASE WHEN p_status IN ('resolved','dismissed') THEN auth.uid() ELSE NULL END,
         resolution_notes = COALESCE(p_notes, resolution_notes),
         updated_at = now()
   WHERE id = p_report_id;
END $$;
GRANT EXECUTE ON FUNCTION public.mod_resolve_report(uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.mod_apply_sanction(
  p_user_id uuid,
  p_type public.forum_sanction_type,
  p_reason text DEFAULT NULL,
  p_duration_hours integer DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_expires timestamptz;
BEGIN
  IF NOT public.is_staff(auth.uid()) THEN RAISE EXCEPTION 'not authorized'; END IF;
  v_expires := CASE WHEN p_duration_hours IS NULL THEN NULL ELSE now() + (p_duration_hours || ' hours')::interval END;
  INSERT INTO public.forum_user_sanctions(user_id, type, reason, expires_at, issued_by)
  VALUES (p_user_id, p_type, p_reason, v_expires, auth.uid())
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
GRANT EXECUTE ON FUNCTION public.mod_apply_sanction(uuid, public.forum_sanction_type, text, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.mod_lift_sanction(p_sanction_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_staff(auth.uid()) THEN RAISE EXCEPTION 'not authorized'; END IF;
  UPDATE public.forum_user_sanctions
     SET lifted_at = now(), lifted_by = auth.uid(), updated_at = now()
   WHERE id = p_sanction_id AND lifted_at IS NULL;
END $$;
GRANT EXECUTE ON FUNCTION public.mod_lift_sanction(uuid) TO authenticated;
