-- Per-account beta access, starting with the Vidu AI background (a second Vidu stream per
-- user: double cost, one more concurrent slot). A separate table rather than a profiles column
-- because customers can update their own profile row; only admins can grant these.

CREATE TABLE IF NOT EXISTS public.user_beta_features (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feature text NOT NULL,
  granted_by uuid,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, feature)
);

ALTER TABLE public.user_beta_features ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own beta features" ON public.user_beta_features;
CREATE POLICY "Users read own beta features" ON public.user_beta_features
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Admins manage beta features" ON public.user_beta_features;
CREATE POLICY "Admins manage beta features" ON public.user_beta_features
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

GRANT SELECT ON public.user_beta_features TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.user_beta_features TO authenticated;
GRANT ALL ON public.user_beta_features TO service_role;

-- First tester.
INSERT INTO public.user_beta_features (user_id, feature)
SELECT user_id, 'ai_background' FROM public.profiles WHERE lower(email) = 'boigrammer@gmail.com'
ON CONFLICT DO NOTHING;
