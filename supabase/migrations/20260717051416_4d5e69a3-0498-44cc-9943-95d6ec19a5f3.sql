
CREATE OR REPLACE FUNCTION public.admin_time_ledger()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_admin boolean;
  v_cps numeric;
  v_result jsonb;
  v_totals jsonb;
  v_users jsonb;
  v_keys jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT COALESCE(credits_per_second, 2.083) INTO v_cps
  FROM public.studio_pricing_config WHERE id = true LIMIT 1;
  IF v_cps IS NULL THEN v_cps := 2.083; END IF;

  -- Per-key used_ms rollup (all sessions ever)
  WITH sess AS (
    SELECT
      api_key_id,
      user_id,
      is_trial,
      SUM(COALESCE(duration_ms,0))::bigint AS used_ms,
      COUNT(*)::int AS sessions,
      MAX(COALESCE(ended_at, last_heartbeat_at, started_at)) AS last_session_at,
      MAX(started_at) AS last_started_at,
      bool_or(ended_at IS NULL AND last_heartbeat_at > now() - interval '20 seconds') AS is_live
    FROM public.studio_sessions
    GROUP BY api_key_id, user_id, is_trial
  ),
  -- Paid keys
  paid AS (
    SELECT
      k.id AS key_id,
      k.user_id,
      k.label,
      'paid'::text AS key_type,
      k.is_active,
      k.created_at,
      k.expires_at,
      COALESCE(k.remaining_ms, 0)::bigint AS remaining_ms,
      COALESCE(s.used_ms, 0)::bigint AS used_ms,
      (COALESCE(k.remaining_ms,0) + COALESCE(s.used_ms,0))::bigint AS allocated_ms,
      COALESCE(s.sessions, 0) AS sessions,
      s.last_session_at,
      COALESCE(s.is_live, false) AS is_live
    FROM public.api_keys k
    LEFT JOIN sess s ON s.api_key_id = k.id
  ),
  -- Trial keys: allocated = trial_duration_ms; remaining = trial_duration_ms - used
  trial AS (
    SELECT
      t.id AS key_id,
      t.claimed_by_user_id AS user_id,
      'Trial'::text AS label,
      'trial'::text AS key_type,
      (t.claimed_by_user_id IS NOT NULL) AS is_active,
      t.created_at,
      NULL::timestamptz AS expires_at,
      GREATEST(0, COALESCE(t.trial_duration_ms,0) - COALESCE(s.used_ms,0))::bigint AS remaining_ms,
      COALESCE(s.used_ms, 0)::bigint AS used_ms,
      COALESCE(t.trial_duration_ms, 0)::bigint AS allocated_ms,
      COALESCE(s.sessions, 0) AS sessions,
      s.last_session_at,
      COALESCE(s.is_live, false) AS is_live
    FROM public.free_trial_keys t
    LEFT JOIN sess s ON s.api_key_id = t.id
    WHERE t.claimed_by_user_id IS NOT NULL
  ),
  all_keys AS (
    SELECT * FROM paid
    UNION ALL
    SELECT * FROM trial
  ),
  key_rows AS (
    SELECT ak.*, p.email, p.display_name
    FROM all_keys ak
    LEFT JOIN public.profiles p ON p.user_id = ak.user_id
  )
  SELECT
    jsonb_build_object(
      'allocated_ms', COALESCE(SUM(allocated_ms) FILTER (WHERE true), 0),
      'used_ms',      COALESCE(SUM(used_ms), 0),
      'remaining_ms', COALESCE(SUM(remaining_ms), 0),
      'allocated_ms_paid',  COALESCE(SUM(allocated_ms) FILTER (WHERE key_type='paid'), 0),
      'used_ms_paid',       COALESCE(SUM(used_ms)      FILTER (WHERE key_type='paid'), 0),
      'remaining_ms_paid',  COALESCE(SUM(remaining_ms) FILTER (WHERE key_type='paid'), 0),
      'allocated_ms_trial', COALESCE(SUM(allocated_ms) FILTER (WHERE key_type='trial'), 0),
      'used_ms_trial',      COALESCE(SUM(used_ms)      FILTER (WHERE key_type='trial'), 0),
      'remaining_ms_trial', COALESCE(SUM(remaining_ms) FILTER (WHERE key_type='trial'), 0),
      'keys_total',    COUNT(*),
      'keys_active',   COUNT(*) FILTER (WHERE is_active),
      'keys_live',     COUNT(*) FILTER (WHERE is_live),
      'used_ms_24h',   COALESCE((SELECT SUM(COALESCE(duration_ms,0)) FROM public.studio_sessions WHERE COALESCE(ended_at, last_heartbeat_at, started_at) >= now() - interval '24 hours'), 0),
      'used_ms_7d',    COALESCE((SELECT SUM(COALESCE(duration_ms,0)) FROM public.studio_sessions WHERE COALESCE(ended_at, last_heartbeat_at, started_at) >= now() - interval '7 days'), 0)
    ),
    (
      SELECT COALESCE(jsonb_agg(u ORDER BY u->>'remaining_ms' DESC), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object(
          'user_id', user_id,
          'email', MAX(email),
          'display_name', MAX(display_name),
          'keys_count', COUNT(*),
          'allocated_ms', SUM(allocated_ms),
          'used_ms', SUM(used_ms),
          'remaining_ms', SUM(remaining_ms),
          'sessions', SUM(sessions),
          'last_session_at', MAX(last_session_at),
          'is_live', bool_or(is_live),
          'has_paid', bool_or(key_type='paid'),
          'has_trial', bool_or(key_type='trial')
        ) AS u
        FROM key_rows
        WHERE user_id IS NOT NULL
        GROUP BY user_id
      ) uu
    ),
    (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'key_id', key_id,
        'user_id', user_id,
        'email', email,
        'display_name', display_name,
        'label', label,
        'key_type', key_type,
        'is_active', is_active,
        'is_live', is_live,
        'created_at', created_at,
        'expires_at', expires_at,
        'allocated_ms', allocated_ms,
        'used_ms', used_ms,
        'remaining_ms', remaining_ms,
        'sessions', sessions,
        'last_session_at', last_session_at
      ) ORDER BY remaining_ms DESC), '[]'::jsonb)
      FROM key_rows
    )
  INTO v_totals, v_users, v_keys
  FROM key_rows;

  v_result := jsonb_build_object(
    'generated_at', now(),
    'credits_per_second', v_cps,
    'totals', COALESCE(v_totals, '{}'::jsonb),
    'users',  COALESCE(v_users,  '[]'::jsonb),
    'keys',   COALESCE(v_keys,   '[]'::jsonb)
  );

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_time_ledger() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_time_ledger() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_time_ledger() TO service_role;
