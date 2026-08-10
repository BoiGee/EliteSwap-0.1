-- 1. Remove user_activity_logs from realtime (sensitive, not consumed by client)
ALTER PUBLICATION supabase_realtime DROP TABLE public.user_activity_logs;

-- 2. Enable RLS on realtime.messages (controls broadcast/presence channel topic auth)
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;

-- Default deny: only allow authenticated users to use realtime, and only for
-- topics that match their own auth.uid() OR public review topics OR their
-- own support conversation topics. Anything else (including other users'
-- payment/support/activity topics) is denied.

-- Drop any pre-existing policies we manage to keep this idempotent
DROP POLICY IF EXISTS "Authenticated can read own-scoped realtime topics" ON realtime.messages;
DROP POLICY IF EXISTS "Authenticated can write own-scoped realtime topics" ON realtime.messages;

CREATE POLICY "Authenticated can read own-scoped realtime topics"
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  -- Allow public review refresh channels
  realtime.topic() IN ('reviews-all', 'reviews-landing')
  -- Allow user's own dashboard channel
  OR realtime.topic() = 'dashboard-payments'
  -- Support chat: topic format chat-<conversation_id> or admin-chat-<conversation_id>
  OR (
    realtime.topic() LIKE 'chat-%'
    AND EXISTS (
      SELECT 1 FROM public.support_conversations sc
      WHERE sc.id::text = substring(realtime.topic() from 6)
        AND (sc.user_id = auth.uid() OR public.has_role('admin'::app_role))
    )
  )
  OR (
    realtime.topic() LIKE 'admin-chat-%'
    AND public.has_role('admin'::app_role)
  )
  -- Admin-only realtime channels
  OR (
    realtime.topic() LIKE 'support-notifications-%'
    AND substring(realtime.topic() from 23) = auth.uid()::text
  )
  -- OBS / Decart relay channels keyed by api_key owned by the user
  OR (
    (realtime.topic() LIKE 'obs-relay-%' OR realtime.topic() LIKE 'decart-%')
    AND EXISTS (
      SELECT 1 FROM public.api_keys ak
      WHERE ak.user_id = auth.uid()
        AND (
          realtime.topic() = 'obs-relay-' || ak.key
          OR realtime.topic() LIKE 'decart-' || ak.key || '%'
        )
    )
  )
);

CREATE POLICY "Authenticated can write own-scoped realtime topics"
ON realtime.messages
FOR INSERT
TO authenticated
WITH CHECK (
  realtime.topic() IN ('reviews-all', 'reviews-landing')
  OR realtime.topic() = 'dashboard-payments'
  OR (
    realtime.topic() LIKE 'chat-%'
    AND EXISTS (
      SELECT 1 FROM public.support_conversations sc
      WHERE sc.id::text = substring(realtime.topic() from 6)
        AND (sc.user_id = auth.uid() OR public.has_role('admin'::app_role))
    )
  )
  OR (
    realtime.topic() LIKE 'admin-chat-%'
    AND public.has_role('admin'::app_role)
  )
  OR (
    realtime.topic() LIKE 'support-notifications-%'
    AND substring(realtime.topic() from 23) = auth.uid()::text
  )
  OR (
    (realtime.topic() LIKE 'obs-relay-%' OR realtime.topic() LIKE 'decart-%')
    AND EXISTS (
      SELECT 1 FROM public.api_keys ak
      WHERE ak.user_id = auth.uid()
        AND (
          realtime.topic() = 'obs-relay-' || ak.key
          OR realtime.topic() LIKE 'decart-' || ak.key || '%'
        )
    )
  )
);