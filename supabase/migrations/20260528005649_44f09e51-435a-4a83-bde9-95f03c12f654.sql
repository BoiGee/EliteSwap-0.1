
ALTER TABLE public.api_keys REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.api_keys;
