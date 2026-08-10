-- The admin dashboard's "Total Users" stat (Admin.tsx) is computed from a
-- single fetchAll() on mount with no live updates — verified empirically:
-- supabase_realtime publication had ZERO tables before this migration (every
-- existing supabase.channel() use in the app is presence/broadcast for
-- studio WebRTC signaling, never postgres_changes), so no realtime path for
-- the user count existed to begin with. Adding profiles to the publication
-- lets Admin.tsx subscribe to INSERT/DELETE and refresh the tally live.
-- Existing "Staff can view all profiles" RLS policy (is_staff(auth.uid()))
-- already covers realtime's own RLS check, so no policy changes needed.
ALTER PUBLICATION supabase_realtime ADD TABLE public.profiles;
