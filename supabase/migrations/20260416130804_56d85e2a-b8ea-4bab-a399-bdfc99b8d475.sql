
-- Create activity log table
CREATE TABLE public.user_activity_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  action text NOT NULL,
  page text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.user_activity_logs ENABLE ROW LEVEL SECURITY;

-- Users can view own activity
CREATE POLICY "Users can view own activity"
ON public.user_activity_logs FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

-- Users can insert own activity
CREATE POLICY "Users can insert own activity"
ON public.user_activity_logs FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

-- Admins can view all activity
CREATE POLICY "Admins can view all activity"
ON public.user_activity_logs FOR SELECT
TO authenticated
USING (has_role('admin'::app_role));

-- Index for fast lookups
CREATE INDEX idx_activity_user_id ON public.user_activity_logs(user_id);
CREATE INDEX idx_activity_created_at ON public.user_activity_logs(created_at DESC);
CREATE INDEX idx_activity_action ON public.user_activity_logs(action);

-- Add last_seen_at to profiles
ALTER TABLE public.profiles ADD COLUMN last_seen_at timestamp with time zone DEFAULT now();

-- Enable realtime for activity presence
ALTER PUBLICATION supabase_realtime ADD TABLE public.user_activity_logs;
