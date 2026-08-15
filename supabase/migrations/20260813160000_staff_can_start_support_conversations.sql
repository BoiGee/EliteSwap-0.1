-- Admins/moderators can currently only reply within a conversation the
-- user already started (support_conversations only has an INSERT policy
-- for `auth.uid() = user_id`) — there's no way for staff to message a user
-- first. Adds the missing staff INSERT policy so the admin panel's Support
-- tab can start a new thread with any user.
--
-- Also tightens "Staff can insert messages" (support_messages) while
-- touching this area: the existing policy only checked is_staff(), with no
-- constraint that the row actually claims to be an admin message or that
-- the sender is the caller — a staff account could otherwise insert a
-- message with is_admin=false impersonating the user.
CREATE POLICY "Staff can insert conversations" ON public.support_conversations
  FOR INSERT TO authenticated WITH CHECK (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS "Staff can insert messages" ON public.support_messages;
CREATE POLICY "Staff can insert messages" ON public.support_messages
  FOR INSERT TO authenticated WITH CHECK (
    public.is_staff(auth.uid()) AND is_admin = true AND sender_id = auth.uid()
  );
