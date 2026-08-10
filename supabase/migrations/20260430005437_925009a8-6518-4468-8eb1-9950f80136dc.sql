UPDATE public.broadcasts
SET status = 'failed',
    completed_at = now(),
    error_message = COALESCE(error_message, 'Stuck in sending; manually recovered')
WHERE status = 'sending'
  AND started_at IS NOT NULL
  AND started_at < now() - interval '15 minutes';