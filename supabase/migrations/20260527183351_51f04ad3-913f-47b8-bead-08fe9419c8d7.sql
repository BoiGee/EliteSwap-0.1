
-- Add assignment + priority to conversations
ALTER TABLE public.support_conversations
  ADD COLUMN IF NOT EXISTS assigned_to uuid,
  ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal';

-- Internal notes (admin-only, never visible to user)
CREATE TABLE IF NOT EXISTS public.support_internal_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  author_id uuid NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.support_internal_notes TO authenticated;
GRANT ALL ON public.support_internal_notes TO service_role;

ALTER TABLE public.support_internal_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins view internal notes" ON public.support_internal_notes
  FOR SELECT TO authenticated USING (has_role('admin'::app_role));
CREATE POLICY "Admins insert internal notes" ON public.support_internal_notes
  FOR INSERT TO authenticated WITH CHECK (has_role('admin'::app_role) AND auth.uid() = author_id);
CREATE POLICY "Admins update internal notes" ON public.support_internal_notes
  FOR UPDATE TO authenticated USING (has_role('admin'::app_role));
CREATE POLICY "Admins delete internal notes" ON public.support_internal_notes
  FOR DELETE TO authenticated USING (has_role('admin'::app_role));

-- Canned responses (shared admin templates)
CREATE TABLE IF NOT EXISTS public.support_canned_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  body text NOT NULL,
  shortcut text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.support_canned_responses TO authenticated;
GRANT ALL ON public.support_canned_responses TO service_role;

ALTER TABLE public.support_canned_responses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage canned responses" ON public.support_canned_responses
  FOR ALL TO authenticated USING (has_role('admin'::app_role)) WITH CHECK (has_role('admin'::app_role));

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.support_conversations;
ALTER PUBLICATION supabase_realtime ADD TABLE public.support_internal_notes;
