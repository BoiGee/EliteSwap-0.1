
-- Enums
DO $$ BEGIN CREATE TYPE public.forum_access_level AS ENUM ('public','partners','admins'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.forum_media_kind AS ENUM ('image','audio'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.forum_media_status AS ENUM ('pending','approved','rejected'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.forum_target_kind AS ENUM ('thread','reply'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.forum_report_status AS ENUM ('open','actioned','dismissed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ===== Base tables first (no helper deps) =====
CREATE TABLE public.forum_user_stats (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  reputation int NOT NULL DEFAULT 0,
  threads_count int NOT NULL DEFAULT 0,
  replies_count int NOT NULL DEFAULT 0,
  solutions_count int NOT NULL DEFAULT 0,
  last_post_at timestamptz,
  is_banned boolean NOT NULL DEFAULT false,
  banned_reason text,
  banned_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.forum_user_stats TO anon, authenticated;
GRANT ALL ON public.forum_user_stats TO service_role;
ALTER TABLE public.forum_user_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "stats readable" ON public.forum_user_stats FOR SELECT USING (true);
CREATE POLICY "admins manage stats" ON public.forum_user_stats FOR ALL
  USING (public.has_role('admin'::app_role)) WITH CHECK (public.has_role('admin'::app_role));

CREATE TABLE public.forum_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  icon text,
  sort_order int NOT NULL DEFAULT 0,
  access_level public.forum_access_level NOT NULL DEFAULT 'public',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.forum_categories TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.forum_categories TO authenticated;
GRANT ALL ON public.forum_categories TO service_role;
ALTER TABLE public.forum_categories ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER trg_forum_categories_updated BEFORE UPDATE ON public.forum_categories
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ===== Helpers (now that referenced tables exist) =====
CREATE OR REPLACE FUNCTION public.is_partner(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.partners WHERE user_id = _user_id AND is_active = true);
$$;

CREATE OR REPLACE FUNCTION public.forum_can_view_category(_category_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_lvl public.forum_access_level; BEGIN
  SELECT access_level INTO v_lvl FROM public.forum_categories WHERE id = _category_id AND is_active = true;
  IF v_lvl IS NULL THEN RETURN false; END IF;
  IF v_lvl = 'public' THEN RETURN true; END IF;
  IF auth.uid() IS NULL THEN RETURN false; END IF;
  IF public.has_role('admin'::app_role) THEN RETURN true; END IF;
  IF v_lvl = 'partners' AND public.is_partner(auth.uid()) THEN RETURN true; END IF;
  RETURN false;
END $$;

CREATE OR REPLACE FUNCTION public.forum_is_banned(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT is_banned FROM public.forum_user_stats WHERE user_id = _user_id), false);
$$;

-- ===== Now categories policies =====
CREATE POLICY "categories readable when active+allowed" ON public.forum_categories
  FOR SELECT USING (
    is_active AND (
      access_level = 'public'
      OR (auth.uid() IS NOT NULL AND public.has_role('admin'::app_role))
      OR (access_level = 'partners' AND auth.uid() IS NOT NULL AND public.is_partner(auth.uid()))
    )
  );
CREATE POLICY "admins manage categories" ON public.forum_categories
  FOR ALL USING (public.has_role('admin'::app_role)) WITH CHECK (public.has_role('admin'::app_role));

-- ===== Tags =====
CREATE TABLE public.forum_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  color text,
  usage_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.forum_tags TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.forum_tags TO authenticated;
GRANT ALL ON public.forum_tags TO service_role;
ALTER TABLE public.forum_tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tags readable" ON public.forum_tags FOR SELECT USING (true);
CREATE POLICY "admins manage tags" ON public.forum_tags FOR ALL
  USING (public.has_role('admin'::app_role)) WITH CHECK (public.has_role('admin'::app_role));

-- ===== Threads =====
CREATE TABLE public.forum_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES public.forum_categories(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  slug text NOT NULL,
  body_md text NOT NULL CHECK (char_length(body_md) BETWEEN 1 AND 20000),
  is_pinned boolean NOT NULL DEFAULT false,
  is_locked boolean NOT NULL DEFAULT false,
  is_solved boolean NOT NULL DEFAULT false,
  solved_reply_id uuid,
  views int NOT NULL DEFAULT 0,
  reply_count int NOT NULL DEFAULT 0,
  reaction_count int NOT NULL DEFAULT 0,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  hidden_at timestamptz,
  hidden_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_forum_threads_category ON public.forum_threads(category_id, last_activity_at DESC);
CREATE INDEX idx_forum_threads_author ON public.forum_threads(author_id);
CREATE INDEX idx_forum_threads_fts ON public.forum_threads USING gin (to_tsvector('english', title || ' ' || body_md));
GRANT SELECT ON public.forum_threads TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.forum_threads TO authenticated;
GRANT ALL ON public.forum_threads TO service_role;
ALTER TABLE public.forum_threads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "threads readable" ON public.forum_threads FOR SELECT
  USING (hidden_at IS NULL AND public.forum_can_view_category(category_id));
CREATE POLICY "authors see own threads" ON public.forum_threads FOR SELECT
  USING (auth.uid() = author_id);
CREATE POLICY "admins read all threads" ON public.forum_threads FOR SELECT
  USING (public.has_role('admin'::app_role));
CREATE POLICY "users create threads" ON public.forum_threads FOR INSERT
  WITH CHECK (
    auth.uid() = author_id
    AND NOT public.forum_is_banned(auth.uid())
    AND public.forum_can_view_category(category_id)
    AND EXISTS (SELECT 1 FROM auth.users WHERE id = auth.uid() AND email_confirmed_at IS NOT NULL)
  );
CREATE POLICY "authors update own threads" ON public.forum_threads FOR UPDATE
  USING (auth.uid() = author_id AND NOT is_locked) WITH CHECK (auth.uid() = author_id);
CREATE POLICY "authors delete own threads" ON public.forum_threads FOR DELETE
  USING (auth.uid() = author_id);
CREATE POLICY "admins manage threads" ON public.forum_threads FOR ALL
  USING (public.has_role('admin'::app_role)) WITH CHECK (public.has_role('admin'::app_role));
CREATE TRIGGER trg_forum_threads_updated BEFORE UPDATE ON public.forum_threads
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ===== Thread tags =====
CREATE TABLE public.forum_thread_tags (
  thread_id uuid NOT NULL REFERENCES public.forum_threads(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES public.forum_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (thread_id, tag_id)
);
GRANT SELECT ON public.forum_thread_tags TO anon, authenticated;
GRANT INSERT, DELETE ON public.forum_thread_tags TO authenticated;
GRANT ALL ON public.forum_thread_tags TO service_role;
ALTER TABLE public.forum_thread_tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY "thread_tags readable" ON public.forum_thread_tags FOR SELECT USING (true);
CREATE POLICY "author manages thread tags" ON public.forum_thread_tags FOR ALL
  USING (EXISTS (SELECT 1 FROM public.forum_threads t WHERE t.id = thread_id AND t.author_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.forum_threads t WHERE t.id = thread_id AND t.author_id = auth.uid()));
CREATE POLICY "admins manage thread tags" ON public.forum_thread_tags FOR ALL
  USING (public.has_role('admin'::app_role)) WITH CHECK (public.has_role('admin'::app_role));

-- ===== Replies =====
CREATE TABLE public.forum_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES public.forum_threads(id) ON DELETE CASCADE,
  parent_reply_id uuid REFERENCES public.forum_replies(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  body_md text NOT NULL CHECK (char_length(body_md) BETWEEN 1 AND 10000),
  is_solution boolean NOT NULL DEFAULT false,
  reaction_count int NOT NULL DEFAULT 0,
  hidden_at timestamptz,
  hidden_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_forum_replies_thread ON public.forum_replies(thread_id, created_at);
CREATE INDEX idx_forum_replies_author ON public.forum_replies(author_id);
GRANT SELECT ON public.forum_replies TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.forum_replies TO authenticated;
GRANT ALL ON public.forum_replies TO service_role;
ALTER TABLE public.forum_replies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "replies readable" ON public.forum_replies FOR SELECT
  USING (
    hidden_at IS NULL AND EXISTS (
      SELECT 1 FROM public.forum_threads t
      WHERE t.id = thread_id AND t.hidden_at IS NULL AND public.forum_can_view_category(t.category_id)
    )
  );
CREATE POLICY "authors see own replies" ON public.forum_replies FOR SELECT USING (auth.uid() = author_id);
CREATE POLICY "admins read all replies" ON public.forum_replies FOR SELECT USING (public.has_role('admin'::app_role));
CREATE POLICY "users create replies" ON public.forum_replies FOR INSERT
  WITH CHECK (
    auth.uid() = author_id
    AND NOT public.forum_is_banned(auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.forum_threads t
      WHERE t.id = thread_id AND NOT t.is_locked AND t.hidden_at IS NULL
        AND public.forum_can_view_category(t.category_id)
    )
    AND EXISTS (SELECT 1 FROM auth.users WHERE id = auth.uid() AND email_confirmed_at IS NOT NULL)
  );
CREATE POLICY "authors update own replies" ON public.forum_replies FOR UPDATE
  USING (auth.uid() = author_id) WITH CHECK (auth.uid() = author_id);
CREATE POLICY "authors delete own replies" ON public.forum_replies FOR DELETE
  USING (auth.uid() = author_id);
CREATE POLICY "admins manage replies" ON public.forum_replies FOR ALL
  USING (public.has_role('admin'::app_role)) WITH CHECK (public.has_role('admin'::app_role));
CREATE TRIGGER trg_forum_replies_updated BEFORE UPDATE ON public.forum_replies
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.forum_threads
  ADD CONSTRAINT forum_threads_solved_reply_fk FOREIGN KEY (solved_reply_id) REFERENCES public.forum_replies(id) ON DELETE SET NULL;

-- ===== Media =====
CREATE TABLE public.forum_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  thread_id uuid REFERENCES public.forum_threads(id) ON DELETE CASCADE,
  reply_id uuid REFERENCES public.forum_replies(id) ON DELETE CASCADE,
  kind public.forum_media_kind NOT NULL,
  storage_path text NOT NULL,
  mime text NOT NULL,
  bytes bigint NOT NULL,
  duration_ms int,
  width int,
  height int,
  status public.forum_media_status NOT NULL DEFAULT 'pending',
  reviewed_by uuid REFERENCES auth.users(id),
  reviewed_at timestamptz,
  reject_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_forum_media_thread ON public.forum_media(thread_id);
CREATE INDEX idx_forum_media_reply ON public.forum_media(reply_id);
CREATE INDEX idx_forum_media_pending ON public.forum_media(status) WHERE status = 'pending';
GRANT SELECT ON public.forum_media TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.forum_media TO authenticated;
GRANT ALL ON public.forum_media TO service_role;
ALTER TABLE public.forum_media ENABLE ROW LEVEL SECURITY;
CREATE POLICY "approved media readable" ON public.forum_media FOR SELECT USING (status = 'approved');
CREATE POLICY "owners see own media" ON public.forum_media FOR SELECT USING (auth.uid() = owner_id);
CREATE POLICY "admins see all media" ON public.forum_media FOR SELECT USING (public.has_role('admin'::app_role));
CREATE POLICY "owners insert media" ON public.forum_media FOR INSERT WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "owners delete own media" ON public.forum_media FOR DELETE USING (auth.uid() = owner_id);
CREATE POLICY "admins manage media" ON public.forum_media FOR ALL
  USING (public.has_role('admin'::app_role)) WITH CHECK (public.has_role('admin'::app_role));

-- ===== Reactions =====
CREATE TABLE public.forum_reactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_kind public.forum_target_kind NOT NULL,
  target_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  emoji text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_kind, target_id, user_id, emoji)
);
CREATE INDEX idx_forum_reactions_target ON public.forum_reactions(target_kind, target_id);
GRANT SELECT ON public.forum_reactions TO anon, authenticated;
GRANT INSERT, DELETE ON public.forum_reactions TO authenticated;
GRANT ALL ON public.forum_reactions TO service_role;
ALTER TABLE public.forum_reactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "reactions readable" ON public.forum_reactions FOR SELECT USING (true);
CREATE POLICY "users react" ON public.forum_reactions FOR INSERT
  WITH CHECK (auth.uid() = user_id AND NOT public.forum_is_banned(auth.uid()));
CREATE POLICY "users remove own reactions" ON public.forum_reactions FOR DELETE
  USING (auth.uid() = user_id);

-- ===== Reports =====
CREATE TABLE public.forum_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_kind public.forum_target_kind NOT NULL,
  target_id uuid NOT NULL,
  reporter_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reason text NOT NULL,
  details text,
  status public.forum_report_status NOT NULL DEFAULT 'open',
  handled_by uuid REFERENCES auth.users(id),
  handled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_forum_reports_target ON public.forum_reports(target_kind, target_id);
CREATE INDEX idx_forum_reports_open ON public.forum_reports(status) WHERE status = 'open';
GRANT SELECT, INSERT, UPDATE, DELETE ON public.forum_reports TO authenticated;
GRANT ALL ON public.forum_reports TO service_role;
ALTER TABLE public.forum_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users create reports" ON public.forum_reports FOR INSERT
  WITH CHECK (auth.uid() = reporter_id);
CREATE POLICY "reporters see own" ON public.forum_reports FOR SELECT USING (auth.uid() = reporter_id);
CREATE POLICY "admins manage reports" ON public.forum_reports FOR ALL
  USING (public.has_role('admin'::app_role)) WITH CHECK (public.has_role('admin'::app_role));

-- ===== Subscriptions =====
CREATE TABLE public.forum_subscriptions (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES public.forum_threads(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, thread_id)
);
GRANT SELECT, INSERT, DELETE ON public.forum_subscriptions TO authenticated;
GRANT ALL ON public.forum_subscriptions TO service_role;
ALTER TABLE public.forum_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users see own subs" ON public.forum_subscriptions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "users add own subs" ON public.forum_subscriptions FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users remove own subs" ON public.forum_subscriptions FOR DELETE USING (auth.uid() = user_id);

-- ===== Notifications =====
CREATE TABLE public.forum_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  target_kind public.forum_target_kind,
  target_id uuid,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_forum_notifications_user ON public.forum_notifications(user_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.forum_notifications TO authenticated;
GRANT ALL ON public.forum_notifications TO service_role;
ALTER TABLE public.forum_notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users see own notifications" ON public.forum_notifications FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "users update own notifications" ON public.forum_notifications FOR UPDATE
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users delete own notifications" ON public.forum_notifications FOR DELETE USING (auth.uid() = user_id);
CREATE POLICY "admins manage notifications" ON public.forum_notifications FOR ALL
  USING (public.has_role('admin'::app_role)) WITH CHECK (public.has_role('admin'::app_role));

-- ===== Badges =====
CREATE TABLE public.forum_badges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code text NOT NULL,
  awarded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code)
);
GRANT SELECT ON public.forum_badges TO anon, authenticated;
GRANT ALL ON public.forum_badges TO service_role;
ALTER TABLE public.forum_badges ENABLE ROW LEVEL SECURITY;
CREATE POLICY "badges readable" ON public.forum_badges FOR SELECT USING (true);
CREATE POLICY "admins manage badges" ON public.forum_badges FOR ALL
  USING (public.has_role('admin'::app_role)) WITH CHECK (public.has_role('admin'::app_role));

-- ===== Triggers =====
CREATE OR REPLACE FUNCTION public.forum_award(_user_id uuid, _delta int)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.forum_user_stats (user_id, reputation)
  VALUES (_user_id, _delta)
  ON CONFLICT (user_id) DO UPDATE SET reputation = forum_user_stats.reputation + _delta, updated_at = now();
END $$;

CREATE OR REPLACE FUNCTION public.tg_forum_thread_after_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (SELECT COUNT(*) FROM public.forum_threads WHERE author_id = NEW.author_id AND created_at > now() - interval '1 hour') > 10 THEN
    RAISE EXCEPTION 'Rate limit: too many threads in the last hour' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.forum_user_stats (user_id, threads_count, reputation, last_post_at)
  VALUES (NEW.author_id, 1, 5, now())
  ON CONFLICT (user_id) DO UPDATE SET
    threads_count = forum_user_stats.threads_count + 1,
    reputation = forum_user_stats.reputation + 5,
    last_post_at = now(),
    updated_at = now();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_forum_thread_after_insert AFTER INSERT ON public.forum_threads
  FOR EACH ROW EXECUTE FUNCTION public.tg_forum_thread_after_insert();

CREATE OR REPLACE FUNCTION public.tg_forum_reply_after_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_author uuid; v_title text;
BEGIN
  IF (SELECT COUNT(*) FROM public.forum_replies WHERE author_id = NEW.author_id AND created_at > now() - interval '1 hour') > 30 THEN
    RAISE EXCEPTION 'Rate limit: too many replies in the last hour' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.forum_threads
    SET reply_count = reply_count + 1, last_activity_at = now()
    WHERE id = NEW.thread_id
    RETURNING author_id, title INTO v_author, v_title;
  INSERT INTO public.forum_user_stats (user_id, replies_count, reputation, last_post_at)
  VALUES (NEW.author_id, 1, 2, now())
  ON CONFLICT (user_id) DO UPDATE SET
    replies_count = forum_user_stats.replies_count + 1,
    reputation = forum_user_stats.reputation + 2,
    last_post_at = now(),
    updated_at = now();
  IF v_author IS NOT NULL AND v_author <> NEW.author_id THEN
    INSERT INTO public.forum_notifications (user_id, kind, target_kind, target_id, actor_id, data)
    VALUES (v_author, 'reply', 'thread', NEW.thread_id, NEW.author_id, jsonb_build_object('reply_id', NEW.id, 'thread_title', v_title));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_forum_reply_after_insert AFTER INSERT ON public.forum_replies
  FOR EACH ROW EXECUTE FUNCTION public.tg_forum_reply_after_insert();

CREATE OR REPLACE FUNCTION public.tg_forum_reply_after_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.forum_threads SET reply_count = GREATEST(0, reply_count - 1) WHERE id = OLD.thread_id;
  RETURN OLD;
END $$;
CREATE TRIGGER trg_forum_reply_after_delete AFTER DELETE ON public.forum_replies
  FOR EACH ROW EXECUTE FUNCTION public.tg_forum_reply_after_delete();

CREATE OR REPLACE FUNCTION public.tg_forum_reaction_after_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_delta int; v_recipient uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN v_delta := 1; ELSE v_delta := -1; END IF;
  IF COALESCE(NEW.target_kind, OLD.target_kind) = 'thread' THEN
    UPDATE public.forum_threads
      SET reaction_count = GREATEST(0, reaction_count + v_delta)
      WHERE id = COALESCE(NEW.target_id, OLD.target_id)
      RETURNING author_id INTO v_recipient;
  ELSE
    UPDATE public.forum_replies
      SET reaction_count = GREATEST(0, reaction_count + v_delta)
      WHERE id = COALESCE(NEW.target_id, OLD.target_id)
      RETURNING author_id INTO v_recipient;
  END IF;
  IF v_recipient IS NOT NULL AND v_recipient <> COALESCE(NEW.user_id, OLD.user_id) THEN
    PERFORM public.forum_award(v_recipient, v_delta);
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER trg_forum_reaction_change AFTER INSERT OR DELETE ON public.forum_reactions
  FOR EACH ROW EXECUTE FUNCTION public.tg_forum_reaction_after_change();

CREATE OR REPLACE FUNCTION public.tg_forum_report_autohide()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int;
BEGIN
  SELECT COUNT(*) INTO v_count FROM public.forum_reports
    WHERE target_kind = NEW.target_kind AND target_id = NEW.target_id AND status = 'open';
  IF v_count >= 3 THEN
    IF NEW.target_kind = 'thread' THEN
      UPDATE public.forum_threads SET hidden_at = now(), hidden_reason = 'auto: report threshold'
        WHERE id = NEW.target_id AND hidden_at IS NULL;
    ELSE
      UPDATE public.forum_replies SET hidden_at = now(), hidden_reason = 'auto: report threshold'
        WHERE id = NEW.target_id AND hidden_at IS NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_forum_report_autohide AFTER INSERT ON public.forum_reports
  FOR EACH ROW EXECUTE FUNCTION public.tg_forum_report_autohide();

CREATE OR REPLACE FUNCTION public.forum_mark_solution(p_reply_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_thread RECORD; v_reply RECORD;
BEGIN
  SELECT * INTO v_reply FROM public.forum_replies WHERE id = p_reply_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reply not found'; END IF;
  SELECT * INTO v_thread FROM public.forum_threads WHERE id = v_reply.thread_id;
  IF v_thread.author_id <> auth.uid() AND NOT public.has_role('admin'::app_role) THEN
    RAISE EXCEPTION 'Only the thread author or an admin can mark a solution' USING ERRCODE = '42501';
  END IF;
  IF v_thread.solved_reply_id IS NOT NULL AND v_thread.solved_reply_id <> p_reply_id THEN
    UPDATE public.forum_replies SET is_solution = false WHERE id = v_thread.solved_reply_id;
  END IF;
  UPDATE public.forum_replies SET is_solution = true WHERE id = p_reply_id;
  UPDATE public.forum_threads SET is_solved = true, solved_reply_id = p_reply_id WHERE id = v_thread.id;
  INSERT INTO public.forum_user_stats (user_id, solutions_count, reputation)
  VALUES (v_reply.author_id, 1, 10)
  ON CONFLICT (user_id) DO UPDATE SET
    solutions_count = forum_user_stats.solutions_count + 1,
    reputation = forum_user_stats.reputation + 10,
    updated_at = now();
  INSERT INTO public.forum_badges (user_id, code)
  SELECT v_reply.author_id, 'helper'
  WHERE (SELECT solutions_count FROM public.forum_user_stats WHERE user_id = v_reply.author_id) >= 5
  ON CONFLICT DO NOTHING;
  INSERT INTO public.forum_badges (user_id, code)
  SELECT v_reply.author_id, 'mentor'
  WHERE (SELECT solutions_count FROM public.forum_user_stats WHERE user_id = v_reply.author_id) >= 25
  ON CONFLICT DO NOTHING;
  IF v_reply.author_id <> auth.uid() THEN
    INSERT INTO public.forum_notifications (user_id, kind, target_kind, target_id, actor_id, data)
    VALUES (v_reply.author_id, 'solution', 'reply', p_reply_id, auth.uid(),
      jsonb_build_object('thread_id', v_thread.id, 'thread_title', v_thread.title));
  END IF;
END $$;

-- Seed
INSERT INTO public.forum_categories (slug, name, description, icon, sort_order, access_level) VALUES
  ('announcements', 'Announcements', 'Official news and updates from the team.', 'megaphone', 1, 'public'),
  ('help', 'Help & Support', 'Stuck on something? Get help from the community.', 'life-buoy', 2, 'public'),
  ('workarounds', 'Tips & Workarounds', 'Share clever tricks and workarounds you have discovered.', 'lightbulb', 3, 'public'),
  ('general', 'General Discussion', 'Anything related that does not fit elsewhere.', 'message-square', 4, 'public'),
  ('feature-requests', 'Feature Requests', 'Suggest improvements and new features.', 'sparkles', 5, 'public'),
  ('partners-lounge', 'Partners Lounge', 'Private space for partners to share strategies.', 'handshake', 6, 'partners')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.forum_tags (slug, name, color) VALUES
  ('question', 'Question', '#3b82f6'),
  ('tip', 'Tip', '#10b981'),
  ('bug', 'Bug', '#ef4444'),
  ('discussion', 'Discussion', '#8b5cf6'),
  ('guide', 'Guide', '#f59e0b')
ON CONFLICT (slug) DO NOTHING;
