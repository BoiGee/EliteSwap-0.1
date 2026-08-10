-- Tighten realtime topic SELECT policy: stop embedding raw api key values in
-- 'decart-%' topic names. Use sha256(key) the same way 'obs-relay-' already does.
DROP POLICY IF EXISTS "Authenticated can read own-scoped realtime topics" ON realtime.messages;

CREATE POLICY "Authenticated can read own-scoped realtime topics"
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  (realtime.topic() = ('dashboard-payments-'::text || (auth.uid())::text))
  OR (
    (realtime.topic() LIKE 'chat-%') AND EXISTS (
      SELECT 1 FROM public.support_conversations sc
      WHERE sc.id::text = SUBSTRING(realtime.topic() FROM 6)
        AND (sc.user_id = auth.uid() OR public.has_role('admin'::public.app_role))
    )
  )
  OR ((realtime.topic() LIKE 'admin-chat-%') AND public.has_role('admin'::public.app_role))
  OR ((realtime.topic() LIKE 'support-notifications-%')
       AND SUBSTRING(realtime.topic() FROM 23) = (auth.uid())::text)
  OR (
    (realtime.topic() LIKE 'obs-relay-%') AND EXISTS (
      SELECT 1 FROM public.api_keys ak
      WHERE ak.user_id = auth.uid() AND ak.is_active
        AND realtime.topic() = ('obs-relay-'::text
          || encode(extensions.digest(ak.key, 'sha256'::text), 'hex'::text))
    )
  )
  OR (
    (realtime.topic() LIKE 'decart-%') AND EXISTS (
      SELECT 1 FROM public.api_keys ak
      WHERE ak.user_id = auth.uid() AND ak.is_active
        AND realtime.topic() = ('decart-'::text
          || encode(extensions.digest(ak.key, 'sha256'::text), 'hex'::text))
    )
  )
);