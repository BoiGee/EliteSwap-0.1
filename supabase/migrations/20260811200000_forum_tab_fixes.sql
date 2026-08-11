-- Forum tab audit found two things:
--
-- 1. mod_resolve_report() was completely broken and could never succeed for
--    any input: it assigned the literal 'resolved' to forum_reports.status,
--    but that column's enum (forum_report_status) only allows
--    'open'/'actioned'/'dismissed' — and it referenced resolved_at,
--    resolved_by, resolution_notes columns that don't exist on
--    forum_reports at all (confirmed against live information_schema; the
--    actual audit columns are handled_by/handled_at). Nothing in the
--    frontend calls this RPC today (the admin Reports tab resolves reports
--    via a direct table UPDATE, which works fine under the existing "staff
--    manage reports" RLS policy), so this was a landmine rather than a
--    live outage — but it's the one moderation RPC in this family that
--    didn't match reality, so fixing it here rather than leaving it to
--    fail the first time anything calls it.
--
-- 2. The ban/warn/mute system (forum_user_sanctions + mod_apply_sanction /
--    mod_lift_sanction, added earlier for moderator support) has zero UI
--    anywhere in the app — confirmed by grepping the entire frontend.
--    Worse, the legacy forum_user_stats.is_banned flag that the admin
--    Forum tab's "Bans" list *does* read has no way to ever be set true
--    either (only the "Unban" button exists, which sets it back to
--    false) — so there has never been any way for staff to actually ban,
--    warn, or mute a forum user through the dashboard. This migration
--    doesn't need schema changes for that (the sanctions table/RPCs are
--    already correct, verified above) — the fix is wiring up the admin UI,
--    done alongside this migration in ForumManager.tsx.

-- CREATE OR REPLACE does not drop a function when the parameter list
-- changes shape — it adds a new overload alongside the old one. Drop the
-- old 3-arg (p_report_id, p_status, p_notes) signature explicitly first.
DROP FUNCTION IF EXISTS public.mod_resolve_report(uuid, text, text);

CREATE OR REPLACE FUNCTION public.mod_resolve_report(p_report_id uuid, p_status text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_staff(auth.uid()) THEN RAISE EXCEPTION 'not authorized'; END IF;
  IF p_status NOT IN ('actioned', 'dismissed', 'open') THEN RAISE EXCEPTION 'invalid status'; END IF;
  UPDATE public.forum_reports
     SET status = p_status::public.forum_report_status,
         handled_by = CASE WHEN p_status IN ('actioned', 'dismissed') THEN auth.uid() ELSE NULL END,
         handled_at = CASE WHEN p_status IN ('actioned', 'dismissed') THEN now() ELSE NULL END
   WHERE id = p_report_id;
END;
$$;
