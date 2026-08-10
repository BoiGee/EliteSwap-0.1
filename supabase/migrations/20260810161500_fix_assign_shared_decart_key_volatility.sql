-- assign_shared_decart_key() was marked STABLE in the previous migration,
-- but internally calls random() (volatile). STABLE tells Postgres it's
-- safe to cache/reuse the result within a single statement — which is
-- exactly wrong for a function whose whole purpose is a fresh random pick
-- each call. Verified empirically live: 30 calls in one query returned
-- the same key every time with STABLE, and correctly varied across both
-- pool keys once changed to VOLATILE.
CREATE OR REPLACE FUNCTION public.assign_shared_decart_key()
RETURNS text
LANGUAGE sql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT decart_key FROM public.decart_shared_pool
   WHERE is_active = true
   ORDER BY random()
   LIMIT 1;
$$;
