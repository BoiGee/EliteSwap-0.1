-- Removing the free (unpaid) trial claim system per explicit request:
-- trials are $10 now, and that flow is already live and unaffected by
-- this change.
--
-- Verified before dropping anything (last turn's audit, re-confirmed here):
--   - claim_free_trial_key() (both the 0-arg and (fingerprint,ip_hash)
--     overloads) is unused by 2026-08-11 — no frontend caller anywhere
--     in src/, and live data shows free claims stopped dead on
--     2026-06-08 when the $10 flow took over (23/13/26 free claims in
--     Apr/May/Jun, 0/0 in Jul/Aug while paid claims went 30/0/16/43/11).
--   - admin_allow_trial_for_device() only serves the abuse-detection UI
--     for that same dead path.
--   - Swept every function, trigger and view in the schema for any other
--     reference to device_fingerprint, ip_hash, or these two function
--     names — nothing else touches them.
--   - assign_trial_key_from_purchase (the $10 flow) shares the
--     free_trial_keys / free_trial_assignments TABLES but never calls
--     either of these functions and never sets device_fingerprint/
--     ip_hash — those tables and their pool-management UI stay exactly
--     as they are, untouched by this migration.
--
-- Historical data (device_fingerprint/ip_hash on existing
-- free_trial_assignments rows, and the free-trial keys already claimed
-- by real users months ago) is left in place — this removes the dead
-- mechanism, not the record of who used it.

DROP FUNCTION IF EXISTS public.claim_free_trial_key();
DROP FUNCTION IF EXISTS public.claim_free_trial_key(text, text);
DROP FUNCTION IF EXISTS public.admin_allow_trial_for_device(text);
