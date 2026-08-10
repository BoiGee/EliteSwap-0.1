-- 1. Remove reviews from realtime publication (user_id leak risk)
ALTER PUBLICATION supabase_realtime DROP TABLE public.reviews;

-- 2. Tighten realtime.messages policies: per-user dashboard-payments topic, drop reviews topics
DROP POLICY IF EXISTS "Authenticated can read own-scoped realtime topics" ON realtime.messages;
DROP POLICY IF EXISTS "Authenticated can write own-scoped realtime topics" ON realtime.messages;

CREATE POLICY "Authenticated can read own-scoped realtime topics"
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  -- Per-user dashboard payments channel
  realtime.topic() = 'dashboard-payments-' || auth.uid()::text
  -- Support chat: chat-<conversation_id>
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

CREATE POLICY "Authenticated can write own-scoped realtime topics"
ON realtime.messages
FOR INSERT
TO authenticated
WITH CHECK (
  realtime.topic() = 'dashboard-payments-' || auth.uid()::text
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

-- 3. Restrict broadcast_cooldown_remaining_seconds to service_role only
REVOKE EXECUTE ON FUNCTION public.broadcast_cooldown_remaining_seconds() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.broadcast_cooldown_remaining_seconds() FROM anon;
REVOKE EXECUTE ON FUNCTION public.broadcast_cooldown_remaining_seconds() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.broadcast_cooldown_remaining_seconds() TO service_role;