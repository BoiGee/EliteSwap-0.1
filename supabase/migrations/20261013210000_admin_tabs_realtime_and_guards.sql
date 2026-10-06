-- Admin dashboard audit fixes:
-- 1. The supabase_realtime publication was emptied in the platform migration and only five
--    tables were re-added. Support chat (customer widget and admin inbox), forum
--    notifications and several admin alerts subscribe to tables that were never re-published,
--    so none of them updated live. All are low-write tables.
-- 2. admin_set_active_provider let an admin switch the whole studio to a provider whose key
--    pool has no active key, which breaks every new session.
-- 3. admin_paid_user_usage grouped a confirmed payment with no user into a blank row.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'support_messages', 'support_conversations', 'forum_notifications', 'forum_reports',
    'reviews', 'account_deletion_requests', 'payment_verification_attempts'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.admin_set_active_provider(p_provider text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_active_keys integer;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_provider NOT IN ('decart', 'vidu') THEN
    RAISE EXCEPTION 'invalid provider' USING ERRCODE = '22023';
  END IF;

  IF p_provider = 'vidu' THEN
    SELECT count(*) INTO v_active_keys FROM public.vidu_shared_pool WHERE is_active;
  ELSE
    SELECT count(*) INTO v_active_keys FROM public.decart_shared_pool WHERE is_active;
  END IF;
  IF v_active_keys = 0 THEN
    RAISE EXCEPTION 'The % pool has no active key. Add or activate one before switching.',
      CASE WHEN p_provider = 'vidu' THEN 'Vidu' ELSE 'Decart' END
      USING ERRCODE = '22023';
  END IF;

  SELECT jsonb_build_object('active_provider', active_provider)
    INTO v_before
    FROM public.studio_pricing_config WHERE id = true;

  UPDATE public.studio_pricing_config
     SET active_provider = p_provider,
         updated_at = now()
   WHERE id = true;

  v_after := jsonb_build_object('active_provider', p_provider);

  PERFORM public.log_admin_action('studio_provider_switch', 'studio_pricing_config', 'true', v_before, v_after, '{}'::jsonb);

  RETURN v_after;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_paid_user_usage(p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_include_trial boolean DEFAULT true)
 RETURNS TABLE(user_id uuid, email text, display_name text, total_sessions bigint, total_duration_ms bigint, first_session_at timestamp with time zone, last_session_at timestamp with time zone, avg_duration_ms bigint, is_currently_live boolean, first_payment_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_staff() THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH paid AS (
    SELECT p.user_id, MIN(p.created_at) AS first_payment_at
    FROM payments p
    WHERE p.status = 'confirmed'
      AND p.user_id IS NOT NULL
    GROUP BY p.user_id
  ),
  sess AS (
    SELECT
      s.user_id,
      COUNT(*)::bigint AS total_sessions,
      COALESCE(SUM(
        COALESCE(s.duration_ms, (EXTRACT(EPOCH FROM (now() - s.started_at)) * 1000)::bigint)
      ), 0)::bigint AS total_duration_ms,
      MIN(s.started_at) AS first_session_at,
      MAX(COALESCE(s.last_heartbeat_at, s.started_at)) AS last_session_at
    FROM studio_sessions s
    WHERE (p_from IS NULL OR s.started_at >= p_from)
      AND (p_to IS NULL OR s.started_at <= p_to)
      AND (p_include_trial OR s.is_trial = false)
    GROUP BY s.user_id
  ),
  live AS (
    -- Deliberately independent of p_from/p_to — whether someone is live
    -- right now shouldn't depend on which reporting window is selected.
    SELECT s.user_id, true AS is_currently_live
    FROM studio_sessions s
    WHERE s.ended_at IS NULL
      AND (p_include_trial OR s.is_trial = false)
    GROUP BY s.user_id
  )
  SELECT
    paid.user_id,
    pr.email,
    pr.display_name,
    COALESCE(sess.total_sessions, 0)::bigint,
    COALESCE(sess.total_duration_ms, 0)::bigint,
    sess.first_session_at,
    sess.last_session_at,
    CASE WHEN COALESCE(sess.total_sessions, 0) > 0
         THEN (sess.total_duration_ms / sess.total_sessions)::bigint
         ELSE 0::bigint END,
    COALESCE(live.is_currently_live, false),
    paid.first_payment_at
  FROM paid
  LEFT JOIN sess ON sess.user_id = paid.user_id
  LEFT JOIN live ON live.user_id = paid.user_id
  LEFT JOIN profiles pr ON pr.user_id = paid.user_id;
END;
$function$;
