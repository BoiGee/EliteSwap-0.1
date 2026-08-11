-- Announcements tab audit. Two real gaps found and fixed.
--
-- GAP 1: the UI states outright "Only one announcement can be active at a
-- time," but nothing enforced it — admin_create_announcement,
-- admin_update_announcement, and admin_set_announcement_active all just
-- set is_active on the one row they touch, never touching any other row.
-- An admin creating/activating a second announcement without remembering
-- to deactivate the first would end up with two rows both showing
-- "Active" in the admin list, contradicting what the toggle states imply.
-- The public-facing hook (useActiveAnnouncement) already defends against
-- this by only ever picking the single most-recently-updated active row
-- (order by updated_at desc, limit 1) — so end users were never shown two
-- announcements at once — but the admin's own view of "what's active" was
-- capable of silently drifting from what's actually displayed, which is
-- exactly the kind of gap that causes a real "wait, why isn't my
-- announcement showing" support moment later. Fixed by making activation
-- atomic: setting one announcement active now deactivates every other row
-- in the same statement, so the promise the UI already makes is actually
-- true at the data layer, not just accidentally true at the display layer.
--
-- GAP 2: admin_list_announcement_viewers (the "Views" button's RPC) only
-- allowed admin OR moderator — missing sec_admin, even though the
-- Announcements tab itself (and this exact button) is visible to sec_admin
-- too (it's in the base MODERATOR_TABS set every non-admin staff role
-- gets), and the table's own RLS policy ("Staff view all announcements")
-- already correctly uses is_staff() = admin OR moderator OR sec_admin.
-- Verified live: the one real sec_admin account would hit "Forbidden"
-- clicking Views on any announcement. Fixed to match is_staff(), same as
-- the table's RLS. admin_list_thread_viewers — the identical sibling
-- function the same ViewersDialog component calls for forum threads — had
-- the exact same bug; fixed alongside since it's the same root cause in
-- the same component.

CREATE OR REPLACE FUNCTION public.admin_create_announcement(p_title text, p_message text, p_severity text, p_display_banner boolean, p_display_modal boolean, p_cta_label text, p_cta_url text, p_is_active boolean)
RETURNS system_announcements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_row public.system_announcements;
BEGIN
  IF NOT public.has_role('admin'::app_role) THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.system_announcements
    (title, message, severity, display_banner, display_modal, cta_label, cta_url, is_active, created_by)
  VALUES
    (p_title, p_message, p_severity, p_display_banner, p_display_modal,
     NULLIF(btrim(COALESCE(p_cta_label,'')),''),
     NULLIF(btrim(COALESCE(p_cta_url,'')),''),
     p_is_active, auth.uid())
  RETURNING * INTO v_row;

  IF p_is_active THEN
    UPDATE public.system_announcements
       SET is_active = false, updated_at = now()
     WHERE id <> v_row.id AND is_active = true;
  END IF;

  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_update_announcement(p_id uuid, p_title text, p_message text, p_severity text, p_display_banner boolean, p_display_modal boolean, p_cta_label text, p_cta_url text, p_is_active boolean)
RETURNS system_announcements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_row public.system_announcements;
BEGIN
  IF NOT public.has_role('admin'::app_role) THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;
  UPDATE public.system_announcements
     SET title = p_title,
         message = p_message,
         severity = p_severity,
         display_banner = p_display_banner,
         display_modal = p_display_modal,
         cta_label = NULLIF(btrim(COALESCE(p_cta_label,'')),''),
         cta_url = NULLIF(btrim(COALESCE(p_cta_url,'')),''),
         is_active = p_is_active,
         updated_at = now()
   WHERE id = p_id
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Announcement not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_is_active THEN
    UPDATE public.system_announcements
       SET is_active = false, updated_at = now()
     WHERE id <> v_row.id AND is_active = true;
  END IF;

  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_set_announcement_active(p_id uuid, p_is_active boolean)
RETURNS system_announcements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_row public.system_announcements;
BEGIN
  IF NOT public.has_role('admin'::app_role) THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;
  UPDATE public.system_announcements
     SET is_active = p_is_active, updated_at = now()
   WHERE id = p_id
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Announcement not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_is_active THEN
    UPDATE public.system_announcements
       SET is_active = false, updated_at = now()
     WHERE id <> v_row.id AND is_active = true;
  END IF;

  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_list_announcement_viewers(p_announcement_id uuid)
RETURNS TABLE(user_id uuid, email text, display_name text, first_viewed_at timestamp with time zone, last_viewed_at timestamp with time zone, view_count integer)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT v.user_id,
         p.email,
         p.display_name,
         v.first_viewed_at,
         v.last_viewed_at,
         v.view_count
  FROM public.announcement_views v
  LEFT JOIN public.profiles p ON p.user_id = v.user_id
  WHERE v.announcement_id = p_announcement_id
  ORDER BY v.last_viewed_at DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_list_thread_viewers(p_thread_id uuid)
RETURNS TABLE(user_id uuid, email text, display_name text, first_viewed_at timestamp with time zone, last_viewed_at timestamp with time zone, view_count integer)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT v.user_id,
         p.email,
         p.display_name,
         v.first_viewed_at,
         v.last_viewed_at,
         v.view_count
  FROM public.forum_thread_views v
  LEFT JOIN public.profiles p ON p.user_id = v.user_id
  WHERE v.thread_id = p_thread_id
  ORDER BY v.last_viewed_at DESC;
END;
$function$;
