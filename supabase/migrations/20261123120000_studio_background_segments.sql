-- Elite AI background usage log (admin-only).
--
-- The Elite AI background runs as a second Vidu stream on top of the character swap, so every
-- second it's on costs a second Vidu credit. Studio metering is wall-clock per session and doesn't
-- record it, so this keeps one row per stretch the background was on:
--   * started  -- mint-vidu-rtc-session inserts the row (service role) when it creates the
--                 background stream, and returns its id to the studio;
--   * ended    -- the studio calls end_studio_background_segment() when the background stops
--                 (switched off, failed, disconnect); if it never gets to (tab closed, network),
--                 the session-close trigger below ends it at the session's last heartbeat.
-- Recording only: nothing here changes billing. Only admins can read it.

CREATE TABLE IF NOT EXISTS public.studio_background_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text NOT NULL,
  user_id uuid NOT NULL,
  api_key_id uuid,
  vidu_live_id text,
  vidu_pool_key_id uuid,
  resolution text,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  end_reason text,
  CONSTRAINT studio_background_segments_end_after_start CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX IF NOT EXISTS studio_background_segments_session_idx ON public.studio_background_segments (session_id);
CREATE INDEX IF NOT EXISTS studio_background_segments_started_idx ON public.studio_background_segments (started_at DESC);
CREATE INDEX IF NOT EXISTS studio_background_segments_open_idx ON public.studio_background_segments (session_id) WHERE ended_at IS NULL;

ALTER TABLE public.studio_background_segments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.studio_background_segments FROM anon, authenticated;
GRANT SELECT ON public.studio_background_segments TO authenticated;
DROP POLICY IF EXISTS "Admins read background segments" ON public.studio_background_segments;
CREATE POLICY "Admins read background segments" ON public.studio_background_segments
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::app_role));

-- The studio ends its own segment. Only the owner, only an open one.
CREATE OR REPLACE FUNCTION public.end_studio_background_segment(p_segment_id uuid, p_reason text DEFAULT NULL)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.studio_background_segments
     SET ended_at = GREATEST(started_at, now()),
         end_reason = left(COALESCE(NULLIF(btrim(p_reason), ''), 'stopped'), 60)
   WHERE id = p_segment_id
     AND user_id = auth.uid()
     AND ended_at IS NULL;
$$;
REVOKE ALL ON FUNCTION public.end_studio_background_segment(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.end_studio_background_segment(uuid, text) TO authenticated;

-- Safety net: when a studio session closes, close its open background segments at the session's
-- last heartbeat (heartbeats come every 1.5 s). Never allowed to fail the session update, which
-- is the billing path.
CREATE OR REPLACE FUNCTION public.tg_studio_sessions_close_background()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    UPDATE public.studio_background_segments b
       SET ended_at = GREATEST(b.started_at,
                               LEAST(NEW.ended_at, COALESCE(NEW.last_heartbeat_at, NEW.ended_at) + interval '5 seconds')),
           end_reason = 'session_ended'
     WHERE b.session_id = NEW.session_id
       AND b.user_id = NEW.user_id
       AND b.ended_at IS NULL;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'close background segments for session % failed: %', NEW.session_id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS studio_sessions_close_background ON public.studio_sessions;
CREATE TRIGGER studio_sessions_close_background
  AFTER UPDATE OF ended_at ON public.studio_sessions
  FOR EACH ROW
  WHEN (OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL)
  EXECUTE FUNCTION public.tg_studio_sessions_close_background();

-- Admin summary for the Usage tab: totals, share of studio time, per-user and recent segments.
CREATE OR REPLACE FUNCTION public.admin_studio_background_usage(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_since timestamptz := now() - make_interval(days => GREATEST(1, LEAST(COALESCE(p_days, 30), 365)));
  v jsonb;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'Admins only' USING ERRCODE = '42501';
  END IF;
  WITH seg AS (
    SELECT b.*, EXTRACT(epoch FROM (COALESCE(b.ended_at, now()) - b.started_at)) AS secs
      FROM public.studio_background_segments b
     WHERE b.started_at >= v_since
  ), studio AS (
    SELECT COALESCE(sum(EXTRACT(epoch FROM (COALESCE(s.ended_at, s.last_heartbeat_at, now()) - s.started_at))), 0) AS secs
      FROM public.studio_sessions s
     WHERE s.started_at >= v_since AND s.vidu_pool_key_id IS NOT NULL
  )
  SELECT jsonb_build_object(
    'since', v_since,
    'total_seconds', COALESCE((SELECT round(sum(secs)) FROM seg), 0),
    'segments', (SELECT count(*) FROM seg),
    'sessions', (SELECT count(DISTINCT session_id) FROM seg),
    'users', (SELECT count(DISTINCT user_id) FROM seg),
    'live_now', (SELECT count(*) FROM seg WHERE ended_at IS NULL),
    'studio_seconds', (SELECT round(secs) FROM studio),
    'by_user', COALESCE((
      SELECT jsonb_agg(u ORDER BY u.seconds DESC) FROM (
        SELECT seg.user_id, p.email, round(sum(seg.secs)) AS seconds,
               count(DISTINCT seg.session_id) AS sessions, max(seg.started_at) AS last_used
          FROM seg LEFT JOIN public.profiles p ON p.user_id = seg.user_id
         GROUP BY seg.user_id, p.email
      ) u), '[]'::jsonb),
    'recent', COALESCE((
      SELECT jsonb_agg(r ORDER BY r.started_at DESC) FROM (
        SELECT seg.id, seg.session_id, p.email, seg.started_at, seg.ended_at,
               round(seg.secs) AS seconds, seg.end_reason, seg.resolution
          FROM seg LEFT JOIN public.profiles p ON p.user_id = seg.user_id
         ORDER BY seg.started_at DESC
         LIMIT 50
      ) r), '[]'::jsonb)
  ) INTO v;
  RETURN v;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_studio_background_usage(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_studio_background_usage(integer) TO authenticated;
