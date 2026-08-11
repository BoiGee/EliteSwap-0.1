-- Key Activity tab audit. User-reported symptom verified against live data:
-- "some little credits drain but no corresponding key activity matches."
--
-- Root cause found: public.studio_time_debts + collect_studio_time_debt().
-- When an admin runs admin_debit_burn_offender(s_bulk) to reclaim wasted
-- time (short sessions / handshake burns) and the offending user's keys
-- don't currently have enough balance to cover it, the shortfall is
-- deferred into studio_time_debts (owed_ms/settled_ms, settled_at IS NULL).
-- Two triggers on api_keys (trg_api_keys_collect_debt_ins/_upd) then
-- silently collect that debt automatically the next time ANY of that
-- user's keys gains balance (new key issued, top-up, admin credit) — via
-- collect_studio_time_debt(), which debits api_keys.remaining_ms directly.
--
-- That collection never touches studio_sessions or studio_credential_mints
-- — the only two sources admin_list_key_activity() reads from — so it is
-- 100% invisible in the Key Activity tab (and in admin_key_session_detail's
-- per-key drill-down). It only ever wrote one line to admin_audit_logs.
--
-- Verified live: 15 studio_time_debts rows exist (created 2026-07-30,
-- 462ms-42147ms each, source='burn_reclaim'). One already fired silently
-- on 2026-08-10 (3,676ms taken from user 7406af80…, zero trace in Key
-- Activity for that key). The other 14 are still armed and will fire the
-- next time each of those users' balance increases, with no admin or user
-- ever seeing why. "Little credits drain" matches exactly — these are
-- half-a-second to 42-second amounts (≈1.5-135 credits at 3.2/s).
--
-- Fixed by (1) having collect_studio_time_debt() record which key(s) it
-- actually debited, (2) surfacing that in admin_list_key_activity() as a
-- new column folded into total_used_ms so the math reconciles, (3)
-- surfacing *outstanding* (not yet collected) debt per user so admins can
-- see a drain coming before it happens instead of after, and (4) doing
-- the same in admin_key_session_detail's per-key drill-down, which is the
-- actual "Audit" screen an admin opens when investigating a mismatch like
-- this.
--
-- Also fixed in the same pass: admin_key_session_detail was gated to
-- admin-only, while the Key Activity tab itself (and the "Audit" button
-- that calls this RPC) is visible to sec_admin and moderator too
-- (MODERATOR_TABS includes key_activity; admin_list_key_activity's own
-- check already allows admin/sec_admin/moderator). Verified live: the
-- one real sec_admin account would hit "admin only" and the dialog would
-- silently show nothing. Narrowed the mismatch by matching the check to
-- admin_list_key_activity's own — this doesn't expose anything new, since
-- moderators already see every field this RPC returns via the list view.

CREATE OR REPLACE FUNCTION public.collect_studio_time_debt(p_user_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  d RECORD;
  k RECORD;
  v_open bigint;
  v_left bigint;
  v_take bigint;
  v_collected bigint := 0;
  v_breakdown jsonb := '[]'::jsonb;
BEGIN
  IF p_user_id IS NULL THEN RETURN 0; END IF;

  FOR d IN
    SELECT id, owed_ms, settled_ms
    FROM public.studio_time_debts
    WHERE user_id = p_user_id AND settled_at IS NULL
    ORDER BY created_at
    FOR UPDATE
  LOOP
    v_open := GREATEST(d.owed_ms - COALESCE(d.settled_ms, 0), 0);
    CONTINUE WHEN v_open <= 0;
    v_left := v_open;

    FOR k IN
      SELECT id, GREATEST(COALESCE(remaining_ms, 0), 0) AS rem
      FROM public.api_keys
      WHERE user_id = p_user_id AND is_active = true
        AND (expires_at IS NULL OR expires_at > now())
        AND COALESCE(remaining_ms, 0) > 0
      ORDER BY expires_at NULLS LAST, created_at
      FOR UPDATE
    LOOP
      EXIT WHEN v_left <= 0;
      v_take := LEAST(v_left, k.rem);
      UPDATE public.api_keys
        SET remaining_ms = GREATEST(COALESCE(remaining_ms, 0) - v_take, 0)
      WHERE id = k.id;
      v_left := v_left - v_take;
      v_collected := v_collected + v_take;
      v_breakdown := v_breakdown || jsonb_build_object('key_id', k.id, 'taken_ms', v_take, 'debt_id', d.id);
    END LOOP;

    IF v_left < v_open THEN
      UPDATE public.studio_time_debts
        SET settled_ms = COALESCE(settled_ms, 0) + (v_open - v_left),
            settled_at = CASE WHEN v_left <= 0 THEN now() ELSE NULL END
      WHERE id = d.id;
    END IF;

    EXIT WHEN v_left > 0; -- no balance left at all
  END LOOP;

  IF v_collected > 0 THEN
    INSERT INTO public.admin_audit_logs (actor_id, actor_email, actor_role, action, target_type, target_id, metadata)
    VALUES (NULL, NULL, 'system', 'studio_time_debt_collected', 'user', p_user_id::text,
      jsonb_build_object('collected_ms', v_collected, 'per_key', v_breakdown));
  END IF;

  RETURN v_collected;
END;
$function$;

-- RETURNS TABLE's column list changed (added debt_collected_ms,
-- pending_debt_ms) — CREATE OR REPLACE can't change an existing function's
-- output shape, so the old signature must be dropped first.
DROP FUNCTION IF EXISTS public.admin_list_key_activity(integer, text);

CREATE OR REPLACE FUNCTION public.admin_list_key_activity(p_days integer DEFAULT 90, p_filter text DEFAULT 'all'::text)
RETURNS TABLE(
  key_id uuid, user_id uuid, user_email text, label text, assigned_at timestamp with time zone,
  expires_at timestamp with time zone, remaining_ms bigint, is_active boolean, active_session_id text,
  is_trial boolean, sessions_count bigint, first_session_at timestamp with time zone,
  last_activity_at timestamp with time zone, total_used_ms bigint, handshake_burn_ms bigint,
  unlinked_mint_count bigint, debt_collected_ms bigint, pending_debt_ms bigint, status text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'sec_admin')
    OR public.has_role(auth.uid(), 'moderator')
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  WITH agg AS (
    SELECT
      s.api_key_id,
      count(*)::bigint AS cnt,
      min(s.started_at) AS first_at,
      max(COALESCE(s.ended_at, s.last_heartbeat_at, s.started_at)) AS last_at,
      COALESCE(sum(
        CASE
          WHEN s.ended_at IS NULL THEN
            GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - s.started_at)) * 1000)::bigint)
          WHEN COALESCE(s.duration_ms, 0) > 0 THEN s.duration_ms
          ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (COALESCE(s.ended_at, s.last_heartbeat_at, s.started_at) - s.started_at)) * 1000)::bigint)
        END
      ), 0)::bigint AS used_ms
    FROM public.studio_sessions s
    WHERE s.api_key_id IS NOT NULL
    GROUP BY s.api_key_id
  ),
  burns AS (
    SELECT api_key_id,
           COALESCE(sum(penalty_ms), 0)::bigint AS burn_ms,
           count(*) FILTER (WHERE penalty_ms IS NOT NULL)::bigint AS burn_cnt
      FROM public.studio_credential_mints
     WHERE ok = true
     GROUP BY api_key_id
  ),
  debt_events AS (
    SELECT (elem->>'key_id')::uuid AS api_key_id,
           SUM((elem->>'taken_ms')::bigint)::bigint AS debt_collected_ms
      FROM public.admin_audit_logs al,
           LATERAL jsonb_array_elements(COALESCE(al.metadata->'per_key', '[]'::jsonb)) elem
     WHERE al.action = 'studio_time_debt_collected'
     GROUP BY 1
  ),
  pending_debts AS (
    SELECT d.user_id AS debt_user_id, SUM(GREATEST(d.owed_ms - COALESCE(d.settled_ms, 0), 0))::bigint AS pending_ms
      FROM public.studio_time_debts d
     WHERE d.settled_at IS NULL
     GROUP BY d.user_id
  )
  SELECT
    k.id AS key_id,
    k.user_id,
    u.email::text AS user_email,
    k.label,
    k.assigned_at,
    k.expires_at,
    k.remaining_ms,
    k.is_active,
    k.active_session_id,
    (k.label ILIKE '%trial%') AS is_trial,
    COALESCE(a.cnt, 0) AS sessions_count,
    a.first_at AS first_session_at,
    a.last_at AS last_activity_at,
    (COALESCE(a.used_ms, 0) + COALESCE(b.burn_ms, 0) + COALESCE(de.debt_collected_ms, 0))::bigint AS total_used_ms,
    COALESCE(b.burn_ms, 0)::bigint AS handshake_burn_ms,
    COALESCE(b.burn_cnt, 0)::bigint AS unlinked_mint_count,
    COALESCE(de.debt_collected_ms, 0)::bigint AS debt_collected_ms,
    COALESCE(pd.pending_ms, 0)::bigint AS pending_debt_ms,
    CASE
      WHEN k.active_session_id IS NOT NULL THEN 'in_use'
      WHEN COALESCE(k.remaining_ms, 0) <= 0 THEN 'exhausted'
      WHEN k.expires_at IS NOT NULL AND k.expires_at < now() AND COALESCE(a.cnt, 0) = 0 THEN 'expired_unused'
      WHEN k.expires_at IS NOT NULL AND k.expires_at < now() THEN 'expired_used'
      WHEN k.is_active THEN 'active'
      ELSE 'inactive'
    END AS status
  FROM public.api_keys k
  LEFT JOIN auth.users u ON u.id = k.user_id
  LEFT JOIN agg a ON a.api_key_id = k.id
  LEFT JOIN burns b ON b.api_key_id = k.id
  LEFT JOIN debt_events de ON de.api_key_id = k.id
  LEFT JOIN pending_debts pd ON pd.debt_user_id = k.user_id
  WHERE k.assigned_at IS NOT NULL
    AND (
      k.assigned_at >= now() - make_interval(days => p_days)
      OR k.active_session_id IS NOT NULL
      OR (a.last_at IS NOT NULL AND a.last_at >= now() - make_interval(days => p_days))
    )
    AND (
      p_filter = 'all'
      OR (p_filter = 'never_used' AND COALESCE(a.cnt, 0) = 0)
      OR (p_filter = 'active'     AND k.is_active AND (k.expires_at IS NULL OR k.expires_at > now()))
      OR (p_filter = 'expired_unused' AND k.expires_at IS NOT NULL AND k.expires_at < now() AND COALESCE(a.cnt, 0) = 0)
      OR (p_filter = 'trial'      AND k.label ILIKE '%trial%')
    )
  ORDER BY COALESCE(a.last_at, k.assigned_at) DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_key_session_detail(p_key_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_key jsonb;
  v_sessions jsonb;
  v_mints jsonb;
  v_debts jsonb;
  v_user_id uuid;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'sec_admin')
    OR public.has_role(auth.uid(), 'moderator')
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT jsonb_build_object(
           'key_id', k.id, 'user_id', k.user_id, 'label', k.label,
           'user_email', p.email, 'display_name', p.display_name,
           'assigned_at', k.assigned_at, 'created_at', k.created_at,
           'expires_at', k.expires_at, 'is_active', k.is_active,
           'remaining_ms', GREATEST(COALESCE(k.remaining_ms, 0), 0),
           'active_session_id', k.active_session_id,
           'active_session_started_at', k.active_session_started_at,
           'last_session_ended_at', k.last_session_ended_at
         ),
         k.user_id
    INTO v_key, v_user_id
  FROM public.api_keys k
  LEFT JOIN public.profiles p ON p.user_id = k.user_id
  WHERE k.id = p_key_id;

  IF v_key IS NULL THEN
    RAISE EXCEPTION 'Key not found';
  END IF;

  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'started_at' DESC), '[]'::jsonb)
    INTO v_sessions
  FROM (
    SELECT jsonb_build_object(
      'id', s.id,
      'session_id', s.session_id,
      'started_at', s.started_at,
      'first_heartbeat_at', s.first_heartbeat_at,
      'last_heartbeat_at', s.last_heartbeat_at,
      'ended_at', s.ended_at,
      'end_reason', s.end_reason,
      'is_trial', s.is_trial,
      'billed_ms', GREATEST(COALESCE(s.duration_ms, 0), 0),
      'wall_ms', GREATEST((EXTRACT(EPOCH FROM (COALESCE(s.ended_at, now()) - s.started_at)) * 1000)::bigint, 0),
      'remaining_ms_at_start', s.remaining_ms_at_start,
      'remaining_ms_at_end', s.remaining_ms_at_end,
      'min_bill_ms', s.min_bill_ms,
      'reconciled_ms', COALESCE((SELECT SUM(rr.debited_ms) FROM public.studio_session_reconciliations rr WHERE rr.session_id = s.id), 0),
      'is_open', (s.ended_at IS NULL)
    ) AS x
    FROM public.studio_sessions s
    WHERE s.api_key_id = p_key_id
  ) q;

  SELECT COALESCE(jsonb_agg(y ORDER BY y->>'minted_at' DESC), '[]'::jsonb)
    INTO v_mints
  FROM (
    SELECT jsonb_build_object(
      'id', m.id,
      'minted_at', m.minted_at,
      'expires_at', m.expires_at,
      'ok', m.ok,
      'reason', m.reason,
      'linked_session_id', m.linked_session_id,
      'settled_at', m.settled_at,
      'penalty_ms', GREATEST(COALESCE(m.penalty_ms, 0), 0),
      'penalty_reason', m.penalty_reason,
      'admin_debited_ms', COALESCE(m.admin_debited_ms, 0)
    ) AS y
    FROM public.studio_credential_mints m
    WHERE m.api_key_id = p_key_id
  ) q2;

  -- Time-debt collections attributed to this specific key (from
  -- collect_studio_time_debt's per-key breakdown), plus any of this
  -- user's debt still outstanding and armed to silently debit whichever
  -- key next gains balance. This is the piece that was previously
  -- invisible here — a remaining_ms drop with zero matching session or
  -- mint row almost always traces back to one of these two.
  SELECT jsonb_build_object(
    'collected', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'collected_at', al.created_at,
               'taken_ms', (elem->>'taken_ms')::bigint,
               'debt_id', elem->>'debt_id'
             ) ORDER BY al.created_at DESC)
      FROM public.admin_audit_logs al,
           LATERAL jsonb_array_elements(COALESCE(al.metadata->'per_key', '[]'::jsonb)) elem
      WHERE al.action = 'studio_time_debt_collected'
        AND (elem->>'key_id')::uuid = p_key_id
    ), '[]'::jsonb),
    'outstanding_ms', COALESCE((
      SELECT SUM(GREATEST(owed_ms - COALESCE(settled_ms, 0), 0))
      FROM public.studio_time_debts
      WHERE user_id = v_user_id AND settled_at IS NULL
    ), 0),
    'outstanding_detail', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'created_at', created_at, 'owed_ms', owed_ms,
               'settled_ms', COALESCE(settled_ms, 0), 'reason', reason
             ) ORDER BY created_at)
      FROM public.studio_time_debts
      WHERE user_id = v_user_id AND settled_at IS NULL
    ), '[]'::jsonb)
  ) INTO v_debts;

  RETURN jsonb_build_object('key', v_key, 'sessions', v_sessions, 'mints', v_mints, 'debts', v_debts);
END;
$function$;

-- Pending time-debts are per-user, not per-key (collect_studio_time_debt
-- takes from whichever of a user's keys next has balance), and a debt can
-- sit unsettled far outside admin_list_key_activity's p_days recency
-- window with no key of theirs otherwise qualifying to be shown at all.
-- Rather than force stale, otherwise-irrelevant keys into that per-key
-- list just to carry a warning badge, this is a standalone summary the
-- Key Activity tab renders as a banner: every user with a live drain
-- armed against their next top-up, independent of which key it lands on.
CREATE OR REPLACE FUNCTION public.admin_list_pending_time_debts()
RETURNS TABLE(user_id uuid, user_email text, display_name text, pending_ms bigint, debt_count bigint, oldest_debt_at timestamp with time zone)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'sec_admin')
    OR public.has_role(auth.uid(), 'moderator')
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  SELECT
    d.user_id,
    u.email::text AS user_email,
    p.display_name,
    SUM(GREATEST(d.owed_ms - COALESCE(d.settled_ms, 0), 0))::bigint AS pending_ms,
    COUNT(*)::bigint AS debt_count,
    MIN(d.created_at) AS oldest_debt_at
  FROM public.studio_time_debts d
  LEFT JOIN auth.users u ON u.id = d.user_id
  LEFT JOIN public.profiles p ON p.user_id = d.user_id
  WHERE d.settled_at IS NULL
  GROUP BY d.user_id, u.email, p.display_name
  HAVING SUM(GREATEST(d.owed_ms - COALESCE(d.settled_ms, 0), 0)) > 0
  ORDER BY pending_ms DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_list_pending_time_debts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_list_pending_time_debts() TO authenticated;
