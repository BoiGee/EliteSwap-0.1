
-- Pool of admin-uploaded free trial API keys
CREATE TABLE public.free_trial_keys (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  api_key TEXT NOT NULL UNIQUE,
  claimed_by_user_id UUID,
  claimed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_free_trial_keys_unclaimed
  ON public.free_trial_keys (created_at)
  WHERE claimed_by_user_id IS NULL;

ALTER TABLE public.free_trial_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view free trial keys"
  ON public.free_trial_keys FOR SELECT
  TO authenticated
  USING (has_role('admin'::app_role));

CREATE POLICY "Admins can insert free trial keys"
  ON public.free_trial_keys FOR INSERT
  TO authenticated
  WITH CHECK (has_role('admin'::app_role));

CREATE POLICY "Admins can update free trial keys"
  ON public.free_trial_keys FOR UPDATE
  TO authenticated
  USING (has_role('admin'::app_role));

CREATE POLICY "Admins can delete free trial keys"
  ON public.free_trial_keys FOR DELETE
  TO authenticated
  USING (has_role('admin'::app_role));

-- Audit trail of trial assignments per user
CREATE TABLE public.free_trial_assignments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  free_trial_key_id UUID NOT NULL REFERENCES public.free_trial_keys(id) ON DELETE CASCADE,
  api_key_record_id UUID NOT NULL REFERENCES public.api_keys(id) ON DELETE CASCADE,
  session_number INTEGER NOT NULL CHECK (session_number BETWEEN 1 AND 2),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (user_id, session_number)
);

CREATE INDEX idx_free_trial_assignments_user ON public.free_trial_assignments(user_id);

ALTER TABLE public.free_trial_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own trial assignments"
  ON public.free_trial_assignments FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Admins can view all trial assignments"
  ON public.free_trial_assignments FOR SELECT
  TO authenticated
  USING (has_role('admin'::app_role));

CREATE POLICY "Admins can delete trial assignments"
  ON public.free_trial_assignments FOR DELETE
  TO authenticated
  USING (has_role('admin'::app_role));

-- Atomic claim function
CREATE OR REPLACE FUNCTION public.claim_free_trial_key()
RETURNS TABLE (
  api_key_id UUID,
  api_key TEXT,
  expires_at TIMESTAMP WITH TIME ZONE,
  session_number INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_email_confirmed TIMESTAMP WITH TIME ZONE;
  v_used_count INTEGER;
  v_next_session INTEGER;
  v_trial_key_id UUID;
  v_trial_api_key TEXT;
  v_new_api_key_id UUID;
  v_expires_at TIMESTAMP WITH TIME ZONE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT email_confirmed_at INTO v_email_confirmed
  FROM auth.users WHERE id = v_user_id;

  IF v_email_confirmed IS NULL THEN
    RAISE EXCEPTION 'Email not verified. Please confirm your email first.' USING ERRCODE = '42501';
  END IF;

  SELECT COUNT(*) INTO v_used_count
  FROM public.free_trial_assignments
  WHERE user_id = v_user_id;

  IF v_used_count >= 2 THEN
    RAISE EXCEPTION 'You have already used your 2 free trial sessions. Please upgrade to continue.' USING ERRCODE = '42501';
  END IF;

  v_next_session := v_used_count + 1;

  -- Atomically claim the next available key
  UPDATE public.free_trial_keys
  SET claimed_by_user_id = v_user_id,
      claimed_at = now()
  WHERE id = (
    SELECT id FROM public.free_trial_keys
    WHERE claimed_by_user_id IS NULL
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING id, api_key INTO v_trial_key_id, v_trial_api_key;

  IF v_trial_key_id IS NULL THEN
    RAISE EXCEPTION 'No free trial keys available right now. Please try again later or upgrade.' USING ERRCODE = 'P0002';
  END IF;

  v_expires_at := now() + interval '2 minutes';

  -- Insert into api_keys (reusing existing timer system)
  INSERT INTO public.api_keys (user_id, key, label, remaining_ms, expires_at, is_active)
  VALUES (v_user_id, v_trial_api_key, 'Free Trial #' || v_next_session, 120000, v_expires_at, true)
  RETURNING id INTO v_new_api_key_id;

  -- Record the assignment
  INSERT INTO public.free_trial_assignments (user_id, free_trial_key_id, api_key_record_id, session_number)
  VALUES (v_user_id, v_trial_key_id, v_new_api_key_id, v_next_session);

  RETURN QUERY SELECT v_new_api_key_id, v_trial_api_key, v_expires_at, v_next_session;
END;
$$;
