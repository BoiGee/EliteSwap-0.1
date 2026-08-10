-- Nothing in the admin dashboard surfaced email pipeline health at all —
-- confirmed via grep across MailerManager.tsx and every other admin
-- component. That's how the pgmq/cron gap (20260810230000) went unnoticed:
-- there was no metric anywhere that would have shown "nothing is sending".
-- This gives admin a real-time view: send outcomes over the last 24h, queue
-- depth (0 = healthy backlog, growing = something's wrong again), and DLQ
-- depth (messages that exhausted retries and need manual attention).
CREATE OR REPLACE FUNCTION public.admin_email_health()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_counts_24h jsonb;
  v_recent_failures jsonb;
  v_queue_depths jsonb;
  v_state record;
BEGIN
  IF NOT (public.has_role(auth.uid(), 'admin'::app_role) OR public.has_role(auth.uid(), 'sec_admin'::app_role)) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT jsonb_object_agg(status, cnt) INTO v_counts_24h
  FROM (
    SELECT status, count(*) AS cnt
    FROM public.email_send_log
    WHERE created_at > now() - interval '24 hours'
    GROUP BY status
  ) s;

  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'created_at' DESC), '[]'::jsonb) INTO v_recent_failures
  FROM (
    SELECT jsonb_build_object(
      'created_at', created_at, 'template_name', template_name,
      'recipient_email', recipient_email, 'status', status, 'error_message', error_message
    ) AS x
    FROM public.email_send_log
    WHERE status IN ('failed', 'dlq')
    ORDER BY created_at DESC
    LIMIT 20
  ) q;

  BEGIN
    SELECT jsonb_build_object(
      'auth_emails', (SELECT count(*) FROM pgmq.q_auth_emails),
      'transactional_emails', (SELECT count(*) FROM pgmq.q_transactional_emails),
      'auth_emails_dlq', (SELECT count(*) FROM pgmq.q_auth_emails_dlq),
      'transactional_emails_dlq', (SELECT count(*) FROM pgmq.q_transactional_emails_dlq)
    ) INTO v_queue_depths;
  EXCEPTION WHEN undefined_table OR invalid_schema_name THEN
    v_queue_depths := jsonb_build_object('error', 'pgmq_not_available');
  END;

  SELECT retry_after_until, batch_size, send_delay_ms INTO v_state
    FROM public.email_send_state WHERE id = 1;

  RETURN jsonb_build_object(
    'counts_24h', COALESCE(v_counts_24h, '{}'::jsonb),
    'recent_failures', v_recent_failures,
    'queue_depths', v_queue_depths,
    'rate_limited_until', v_state.retry_after_until,
    'batch_size', v_state.batch_size,
    'send_delay_ms', v_state.send_delay_ms
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_email_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_email_health() TO authenticated;
