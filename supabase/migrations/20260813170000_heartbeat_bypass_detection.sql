-- Detection for the heartbeat-bypass loophole identified 2026-08-13: the
-- Decart connection is direct browser-to-Decart (see useDecartRealtime.ts),
-- so nothing in this app can actually terminate a live connection — all
-- reap_orphaned_studio_sessions can do is stop billing once a session goes
-- ~90s without a heartbeat and mark it 'orphaned_auto'. If someone blocks
-- the app's own heartbeat call (or drives the minted decart_key directly,
-- bypassing the app entirely) while keeping the underlying connection
-- alive, everything past that ~90s point is unbilled and invisible to us.
--
-- We have no Decart account-level usage API wired into this project (no
-- vault secret, no edge function calls their API for usage data — checked
-- before writing this), so real cross-checking against Decart's own
-- records isn't possible yet. What IS possible: 'orphaned_auto' with a real
-- first_heartbeat_at is the exact signature this exploit produces (a
-- session that started normally, then went silent long enough to need the
-- hard-stale timeout instead of a clean pause/close). A user hitting this
-- repeatedly is a meaningful signal even though a single instance is
-- completely ordinary (closed laptop lid, dead wifi, browser crash — all
-- produce the identical signature). This is a review queue, not proof of
-- abuse — framed that way in both the query and the UI.

CREATE OR REPLACE FUNCTION public.admin_list_heartbeat_bypass_signals(p_days integer DEFAULT 7, p_limit integer DEFAULT 100)
RETURNS TABLE(
  user_id uuid,
  user_email text,
  display_name text,
  incident_count bigint,
  total_unmonitored_ms bigint,
  last_incident_at timestamptz,
  key_labels text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT s.user_id,
         p.email,
         p.display_name,
         COUNT(*)::bigint AS incident_count,
         COALESCE(SUM(s.duration_ms), 0)::bigint AS total_unmonitored_ms,
         MAX(s.ended_at) AS last_incident_at,
         STRING_AGG(DISTINCT s.key_label, ', ')
    FROM public.studio_sessions s
    LEFT JOIN public.profiles p ON p.user_id = s.user_id
   WHERE public.is_staff(auth.uid())
     AND s.end_reason = 'orphaned_auto'
     AND s.first_heartbeat_at IS NOT NULL
     AND s.started_at >= now() - make_interval(days => GREATEST(p_days, 1))
   GROUP BY s.user_id, p.email, p.display_name
  HAVING COUNT(*) >= 2
   ORDER BY COUNT(*) DESC, MAX(s.ended_at) DESC
   LIMIT GREATEST(p_limit, 1);
$$;
GRANT EXECUTE ON FUNCTION public.admin_list_heartbeat_bypass_signals(integer, integer) TO authenticated;

-- Daily digest push to admins when anyone crosses the repeat threshold in
-- the last 24h. Dedup via admin_audit_logs so a persistently flaky user
-- doesn't re-page every single day — once per 3-day cooldown per user.
CREATE OR REPLACE FUNCTION public.check_heartbeat_bypass_alert()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  supabase_url text := 'https://bbxahisheugfryyxfidg.supabase.co';
  service_key text;
  r RECORD;
  v_count integer := 0;
  v_already_alerted boolean;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO service_key
    FROM vault.decrypted_secrets
    WHERE name = 'email_queue_service_role_key'
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN service_key := NULL;
  END;
  IF service_key IS NULL THEN RETURN 0; END IF;

  FOR r IN
    SELECT s.user_id,
           COUNT(*) AS incidents,
           COALESCE(SUM(s.duration_ms), 0) AS unmonitored_ms,
           COALESCE(p.email, p.display_name, s.user_id::text) AS who
      FROM public.studio_sessions s
      LEFT JOIN public.profiles p ON p.user_id = s.user_id
     WHERE s.end_reason = 'orphaned_auto'
       AND s.first_heartbeat_at IS NOT NULL
       AND s.started_at >= now() - interval '24 hours'
     GROUP BY s.user_id, p.email, p.display_name
    HAVING COUNT(*) >= 3
  LOOP
    SELECT EXISTS (
      SELECT 1 FROM public.admin_audit_logs
       WHERE action = 'heartbeat_bypass_alert'
         AND target_id = r.user_id::text
         AND created_at > now() - interval '3 days'
    ) INTO v_already_alerted;
    IF v_already_alerted THEN CONTINUE; END IF;

    PERFORM net.http_post(
      url := supabase_url || '/functions/v1/send-admin-push',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || service_key
      ),
      body := jsonb_build_object(
        'event', 'heartbeat_bypass_signal',
        'title', '🔎 Unmonitored studio session pattern',
        'body', r.who || ' had ' || r.incidents || ' sessions go silent (no heartbeat) in 24h — review in Decart Pool tab. Not proof of abuse; could be a connectivity issue.',
        'url', '/admin?tab=key_pool',
        'tag', 'heartbeat-bypass-' || r.user_id
      )
    );

    INSERT INTO public.admin_audit_logs(actor_id, action, target_type, target_id, metadata)
    VALUES (NULL, 'heartbeat_bypass_alert', 'user', r.user_id::text,
      jsonb_build_object('incidents', r.incidents, 'unmonitored_ms', r.unmonitored_ms));

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$;

SELECT cron.schedule(
  'check-heartbeat-bypass-alert-daily',
  '20 4 * * *',
  $$SELECT public.check_heartbeat_bypass_alert();$$
);
