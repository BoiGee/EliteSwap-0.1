
DROP POLICY IF EXISTS "Authenticated can write own-scoped realtime topics" ON realtime.messages;

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
        AND (sc.user_id = auth.uid() OR public.has_role('admin'::public.app_role))
    )
  )
  OR (
    realtime.topic() LIKE 'admin-chat-%'
    AND public.has_role('admin'::public.app_role)
  )
  OR (
    realtime.topic() LIKE 'support-notifications-%'
    AND substring(realtime.topic() from 23) = auth.uid()::text
  )
  OR (
    realtime.topic() LIKE 'obs-relay-%'
    AND EXISTS (
      SELECT 1 FROM public.api_keys ak
      WHERE ak.user_id = auth.uid()
        AND ak.is_active
        AND realtime.topic() = 'obs-relay-' || encode(extensions.digest(ak.key, 'sha256'::text), 'hex'::text)
    )
  )
  OR (
    realtime.topic() LIKE 'decart-%'
    AND EXISTS (
      SELECT 1 FROM public.api_keys ak
      WHERE ak.user_id = auth.uid()
        AND ak.is_active
        AND realtime.topic() = 'decart-' || encode(extensions.digest(ak.key, 'sha256'::text), 'hex'::text)
    )
  )
);
