-- Broadcasts table
CREATE TABLE public.broadcasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by uuid NOT NULL,
  subject text NOT NULL,
  body_md text NOT NULL,
  cta_label text,
  cta_url text,
  recipient_mode text NOT NULL CHECK (recipient_mode IN ('single','multiple','filter','all')),
  recipient_user_ids uuid[],
  filter_preset text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','sent','failed','canceled')),
  scheduled_for timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  total_matched integer NOT NULL DEFAULT 0,
  suppressed_count integer NOT NULL DEFAULT 0,
  enqueued_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.broadcasts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view broadcasts"
  ON public.broadcasts FOR SELECT TO authenticated
  USING (has_role('admin'::app_role));

CREATE POLICY "Admins can insert broadcasts"
  ON public.broadcasts FOR INSERT TO authenticated
  WITH CHECK (has_role('admin'::app_role) AND auth.uid() = created_by);

CREATE POLICY "Admins can update broadcasts"
  ON public.broadcasts FOR UPDATE TO authenticated
  USING (has_role('admin'::app_role));

CREATE POLICY "Admins can delete broadcasts"
  ON public.broadcasts FOR DELETE TO authenticated
  USING (has_role('admin'::app_role));

CREATE INDEX idx_broadcasts_status ON public.broadcasts(status);
CREATE INDEX idx_broadcasts_scheduled ON public.broadcasts(scheduled_for) WHERE status = 'scheduled';
CREATE INDEX idx_broadcasts_created_at ON public.broadcasts(created_at DESC);

CREATE TRIGGER broadcasts_set_updated_at
  BEFORE UPDATE ON public.broadcasts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Recipients table for preview/audit
CREATE TABLE public.broadcast_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id uuid NOT NULL REFERENCES public.broadcasts(id) ON DELETE CASCADE,
  user_id uuid,
  email text NOT NULL,
  display_name text,
  suppressed boolean NOT NULL DEFAULT false,
  send_status text NOT NULL DEFAULT 'pending' CHECK (send_status IN ('pending','sent','suppressed','failed','skipped')),
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.broadcast_recipients ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view broadcast recipients"
  ON public.broadcast_recipients FOR SELECT TO authenticated
  USING (has_role('admin'::app_role));

CREATE POLICY "Admins can insert broadcast recipients"
  ON public.broadcast_recipients FOR INSERT TO authenticated
  WITH CHECK (has_role('admin'::app_role));

CREATE POLICY "Admins can update broadcast recipients"
  ON public.broadcast_recipients FOR UPDATE TO authenticated
  USING (has_role('admin'::app_role));

CREATE POLICY "Admins can delete broadcast recipients"
  ON public.broadcast_recipients FOR DELETE TO authenticated
  USING (has_role('admin'::app_role));

CREATE INDEX idx_broadcast_recipients_broadcast ON public.broadcast_recipients(broadcast_id);

-- Cooldown helper: returns seconds remaining before next broadcast can fire (0 if ok)
CREATE OR REPLACE FUNCTION public.broadcast_cooldown_remaining_seconds()
RETURNS integer
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT GREATEST(0, 900 - EXTRACT(EPOCH FROM (now() - COALESCE(MAX(started_at), to_timestamp(0))))::int)
  FROM public.broadcasts
  WHERE status IN ('sending','sent') AND started_at IS NOT NULL;
$$;