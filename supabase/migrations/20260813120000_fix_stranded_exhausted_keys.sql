-- Fix: paid users with a healthy remaining_ms balance being shown as
-- "Exhausted". Root cause is two bugs compounding:
--
-- 1) deactivate_expired_api_keys() only ever checked expires_at, never
--    remaining_ms. expires_at is a rolling deadline (now() + remaining_ms)
--    that heartbeats keep re-arming forward while a session is live; if a
--    session ends without something resetting it back to NULL, the stale
--    deadline keeps ticking down in real wall-clock time with nothing left
--    to stop it, and once reached this sweep (called from every dashboard
--    tab every 15s, src/pages/Dashboard.tsx:177-188) flips is_active=false
--    even though remaining_ms was never actually spent down further.
--    ApiKeyTimer.tsx:64 and Dashboard.tsx:120-121 both key off is_active
--    alone, so the user sees "Exhausted" with a full balance underneath.
--
-- 2) close_studio_session() — the RPC behind Live Connections' "Force
--    release"/"End session" buttons — referenced studio_pricing_config's
--    teardown_tail_ms column, which was never actually added to the table
--    (confirmed against the live schema: src/integrations/supabase/types.ts
--    lists no such column). Every call threw and rolled back, so any
--    session an admin tried to release stayed stranded with its
--    active_session_id/expires_at exactly as they were — the trigger case
--    for bug #1 above.

-- Add the column close_studio_session() has been assuming exists since
-- 20260810250000_close_studio_session_floor_tail.sql.
ALTER TABLE public.studio_pricing_config
  ADD COLUMN IF NOT EXISTS teardown_tail_ms integer NOT NULL DEFAULT 2000;

-- Never deactivate a key that still has real time on it, no matter what
-- expires_at says.
CREATE OR REPLACE FUNCTION public.deactivate_expired_api_keys()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM set_config('app.bypass_key_guard', 'on', true);
  UPDATE public.api_keys
  SET is_active = false
  WHERE is_active = true
    AND expires_at IS NOT NULL
    AND expires_at <= now()
    AND (remaining_ms IS NULL OR remaining_ms <= 0);
END;
$function$;

-- One-time repair for keys already stranded by this: is_active was flipped
-- false while a positive balance sat untouched. Also clear any leftover
-- armed expires_at/session lock so the repaired key doesn't immediately
-- re-trip the same sweep.
DO $repair$
BEGIN
  PERFORM set_config('app.bypass_key_guard', 'on', true);
  UPDATE public.api_keys
     SET is_active = true,
         expires_at = NULL,
         active_session_id = NULL,
         active_session_started_at = NULL
   WHERE is_active = false
     AND remaining_ms IS NOT NULL
     AND remaining_ms > 0;
END;
$repair$;
