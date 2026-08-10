
CREATE TABLE public.payment_nudge_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  preset_id text NOT NULL,
  sent_by uuid,
  subject text,
  headline_snippet text,
  sent_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_payment_nudge_history_user_preset_time
  ON public.payment_nudge_history (user_id, preset_id, sent_at DESC);

CREATE INDEX idx_payment_nudge_history_user_time
  ON public.payment_nudge_history (user_id, sent_at DESC);

GRANT SELECT, INSERT ON public.payment_nudge_history TO authenticated;
GRANT ALL ON public.payment_nudge_history TO service_role;

ALTER TABLE public.payment_nudge_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins view nudge history"
  ON public.payment_nudge_history
  FOR SELECT
  TO authenticated
  USING (has_role('admin'::app_role));

CREATE POLICY "Admins insert nudge history"
  ON public.payment_nudge_history
  FOR INSERT
  TO authenticated
  WITH CHECK (has_role('admin'::app_role) AND auth.uid() = sent_by);
