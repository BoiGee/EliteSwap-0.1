
CREATE OR REPLACE FUNCTION public.admin_create_announcement(
  p_title text,
  p_message text,
  p_severity text,
  p_display_banner boolean,
  p_display_modal boolean,
  p_cta_label text,
  p_cta_url text,
  p_is_active boolean
) RETURNS public.system_announcements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_update_announcement(
  p_id uuid,
  p_title text,
  p_message text,
  p_severity text,
  p_display_banner boolean,
  p_display_modal boolean,
  p_cta_label text,
  p_cta_url text,
  p_is_active boolean
) RETURNS public.system_announcements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_announcement_active(p_id uuid, p_is_active boolean)
RETURNS public.system_announcements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_announcement(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role('admin'::app_role) THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.system_announcements WHERE id = p_id;
  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_create_announcement(text,text,text,boolean,boolean,text,text,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_announcement(uuid,text,text,text,boolean,boolean,text,text,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_announcement_active(uuid,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_announcement(uuid) TO authenticated;
