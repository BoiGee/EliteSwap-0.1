-- Reviews tab audit. Found: reviews has no unique constraint on user_id,
-- and one real customer (jaylengentry25@gmail.com) already has 2 rows
-- (2026-05-17 "PERFECTO" and 2026-06-10 "BEST VERY GOOD").
--
-- Root cause: two of the three places a user can submit a review
-- (DeepfakeStudio's post-session prompt, Dashboard's banner) correctly
-- check `count(*) FROM reviews WHERE user_id = ...` before ever showing the
-- form — but the standalone /reviews page (linked directly from the
-- dashboard, "navigate('/reviews#leave')") renders <ReviewForm> completely
-- unguarded, and ReviewForm itself always does a blind INSERT. Visiting
-- that page directly (or clicking through twice) lets any user submit
-- unlimited reviews. The product's own RLS policies ("Users can update own
-- reviews") already signal the intended model is one editable review per
-- user, not unlimited submissions — this third entry point was just
-- missed.
--
-- Also a live, currently-reproducible bug this causes: UserDetailDrawer's
-- admin-side query does `.eq('user_id', userId).maybeSingle()`, which
-- throws for any user with more than one row — opening this specific
-- customer's detail drawer from any admin tab (Users, Paid Users, Key
-- Activity, etc.) errors out right now.
--
-- Fixed here at the data layer (add the constraint the app already assumed
-- existed); the ReviewForm component is fixed alongside to upsert instead
-- of blind-insert so this can't recur through any entry point.
--
-- Existing duplicate resolved by keeping the newer row (2026-06-10, their
-- most recent stated opinion) and removing the older one — matches what an
-- upsert-based flow would have converged to on their second visit anyway.

DELETE FROM public.reviews WHERE id = '4944c17c-4d7a-48c7-8c50-5996021dd421';

ALTER TABLE public.reviews ADD CONSTRAINT reviews_user_id_key UNIQUE (user_id);
