
CREATE TABLE public.system_announcements (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  display_banner BOOLEAN NOT NULL DEFAULT true,
  display_modal BOOLEAN NOT NULL DEFAULT false,
  cta_label TEXT,
  cta_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT false,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.system_announcements TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.system_announcements TO authenticated;
GRANT ALL ON public.system_announcements TO service_role;

ALTER TABLE public.system_announcements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view active announcements"
  ON public.system_announcements FOR SELECT
  USING (is_active = true);

CREATE POLICY "Admins view all announcements"
  ON public.system_announcements FOR SELECT
  TO authenticated
  USING (has_role('admin'::app_role));

CREATE POLICY "Admins insert announcements"
  ON public.system_announcements FOR INSERT
  TO authenticated
  WITH CHECK (has_role('admin'::app_role));

CREATE POLICY "Admins update announcements"
  ON public.system_announcements FOR UPDATE
  TO authenticated
  USING (has_role('admin'::app_role))
  WITH CHECK (has_role('admin'::app_role));

CREATE POLICY "Admins delete announcements"
  ON public.system_announcements FOR DELETE
  TO authenticated
  USING (has_role('admin'::app_role));

CREATE OR REPLACE FUNCTION public.system_announcements_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_system_announcements_updated_at
  BEFORE UPDATE ON public.system_announcements
  FOR EACH ROW EXECUTE FUNCTION public.system_announcements_set_updated_at();

CREATE OR REPLACE FUNCTION public.system_announcements_enforce_single_active()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.is_active THEN
    UPDATE public.system_announcements
      SET is_active = false
      WHERE id <> NEW.id AND is_active = true;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_system_announcements_single_active
  AFTER INSERT OR UPDATE OF is_active ON public.system_announcements
  FOR EACH ROW WHEN (NEW.is_active = true)
  EXECUTE FUNCTION public.system_announcements_enforce_single_active();

ALTER PUBLICATION supabase_realtime ADD TABLE public.system_announcements;
ALTER TABLE public.system_announcements REPLICA IDENTITY FULL;
