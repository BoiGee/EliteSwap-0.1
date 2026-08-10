
-- 1) Remove raw `key` column from realtime broadcasts on api_keys
ALTER PUBLICATION supabase_realtime DROP TABLE public.api_keys;
ALTER TABLE public.api_keys REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.api_keys
  (id, user_id, label, is_active, created_at, expires_at, remaining_ms,
   active_session_id, active_session_started_at, last_session_ended_at,
   payment_id, pool_key_id, assigned_at);

-- 2) Pin search_path on pgmq wrapper functions
ALTER FUNCTION public.read_email_batch(text, integer, integer) SET search_path = public, pgmq;
ALTER FUNCTION public.delete_email(text, bigint) SET search_path = public, pgmq;
ALTER FUNCTION public.move_to_dlq(text, text, bigint, jsonb) SET search_path = public, pgmq;
ALTER FUNCTION public.enqueue_email(text, jsonb) SET search_path = public, pgmq;
