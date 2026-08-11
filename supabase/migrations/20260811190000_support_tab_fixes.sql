-- Support tab audit found the chat widget's "reuse or create" logic
-- (SELECT status='open' conversation, INSERT one if none found) is a
-- classic check-then-act race with no DB-level guard. Live data proves it:
-- 6 users currently have duplicate 'open' support_conversations rows for
-- the same user_id, including one user with 3 rows inserted within 1.5s
-- (two of them 9ms apart) — unmistakably a race, not separate legitimate
-- tickets. In every case exactly one sibling in the group has zero
-- messages (the "loser" of the race, silently orphaned forever since nothing
-- ever routes new messages to it again). Fixed at the source with a partial
-- unique index, after first cleaning up the confirmed-empty duplicates so
-- the index can actually be created. The frontend (SupportChat.tsx) now
-- handles the resulting unique-violation gracefully by re-querying for the
-- conversation that won the race, instead of leaving the widget stuck.
--
-- Also found: chk_file_url_domain and the two admin-push trigger functions
-- (trigger_admin_push_support / trigger_admin_push_forum_report) were
-- already hand-patched on the live database during an earlier migration
-- cleanup to point at the current project (bbxahisheugfryyxfidg) instead of
-- the old Lovable project (clxdvyeumnvmalxbymwh) — but the migration files
-- that originally created them were never updated, so replaying migration
-- history from scratch would silently reintroduce the dead references.
-- Re-asserting the already-live-correct definitions here so migration
-- history matches reality.

-- 1) One-time cleanup: remove empty duplicate 'open' conversations, i.e.
--    conversations that have zero messages AND zero internal notes AND
--    whose user has another 'open' conversation that isn't empty. Never
--    touches a user's only conversation, even if it happens to be empty
--    (that's just someone who opened the widget and hasn't typed yet).
DELETE FROM public.support_conversations sc
WHERE sc.status = 'open'
  AND NOT EXISTS (SELECT 1 FROM public.support_messages sm WHERE sm.conversation_id = sc.id)
  AND NOT EXISTS (SELECT 1 FROM public.support_internal_notes sn WHERE sn.conversation_id = sc.id)
  AND EXISTS (
    SELECT 1 FROM public.support_conversations sc2
    WHERE sc2.user_id = sc.user_id AND sc2.id <> sc.id AND sc2.status = 'open'
  );

-- 2) Prevent it from ever happening again: at most one 'open' conversation
--    per user at the database level.
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_conversations_one_open_per_user
  ON public.support_conversations (user_id)
  WHERE status = 'open';

-- 3) Re-assert the already-live-correct URLs so migration history matches
--    the current database (no behavior change — same definitions as live).
CREATE OR REPLACE FUNCTION public.trigger_admin_push_support()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  supabase_url text := 'https://bbxahisheugfryyxfidg.supabase.co';
  service_key text;
  preview text;
BEGIN
  IF NEW.is_admin THEN
    RETURN NEW;
  END IF;
  BEGIN
    SELECT decrypted_secret INTO service_key
    FROM vault.decrypted_secrets
    WHERE name = 'email_queue_service_role_key'
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    service_key := NULL;
  END;
  IF service_key IS NULL THEN
    RETURN NEW;
  END IF;
  preview := left(coalesce(NEW.content, ''), 80);
  PERFORM net.http_post(
    url := supabase_url || '/functions/v1/send-admin-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    body := jsonb_build_object(
      'event', 'support_message',
      'title', 'New support message',
      'body', preview,
      'url', '/admin',
      'tag', 'support-' || NEW.conversation_id
    )
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.trigger_admin_push_forum_report()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  supabase_url text := 'https://bbxahisheugfryyxfidg.supabase.co';
  service_key text;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO service_key
    FROM vault.decrypted_secrets
    WHERE name = 'email_queue_service_role_key'
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    service_key := NULL;
  END;
  IF service_key IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM net.http_post(
    url := supabase_url || '/functions/v1/send-admin-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    body := jsonb_build_object(
      'event', 'forum_report',
      'title', 'New forum report',
      'body', coalesce(NEW.reason, '') || ' • ' || coalesce(NEW.target_kind::text, ''),
      'url', '/admin',
      'tag', 'report-' || NEW.id
    )
  );
  RETURN NEW;
END;
$$;

ALTER TABLE public.support_messages
  DROP CONSTRAINT IF EXISTS chk_file_url_domain;
ALTER TABLE public.support_messages
  ADD CONSTRAINT chk_file_url_domain CHECK (
    file_url IS NULL
    OR file_url LIKE 'https://bbxahisheugfryyxfidg.supabase.co/storage/%'
  );
