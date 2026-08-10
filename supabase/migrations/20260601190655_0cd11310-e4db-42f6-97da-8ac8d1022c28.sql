CREATE TABLE public.terms_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  email text,
  terms_version text NOT NULL,
  source text NOT NULL,
  user_agent text,
  ip_hash text,
  accepted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_terms_acceptances_user_id ON public.terms_acceptances(user_id);
CREATE INDEX idx_terms_acceptances_accepted_at ON public.terms_acceptances(accepted_at DESC);

GRANT SELECT, INSERT ON public.terms_acceptances TO authenticated;
GRANT ALL ON public.terms_acceptances TO service_role;

ALTER TABLE public.terms_acceptances ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can insert own acceptances"
  ON public.terms_acceptances
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can view own acceptances"
  ON public.terms_acceptances
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Admins can view all acceptances"
  ON public.terms_acceptances
  FOR SELECT
  TO authenticated
  USING (has_role('admin'::app_role));