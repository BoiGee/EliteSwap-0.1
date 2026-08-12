-- CRITICAL security fix, found during a full project security audit.
--
-- These SECURITY DEFINER functions had EXECUTE granted to `anon` and
-- `authenticated` (Supabase's default: functions are granted to PUBLIC on
-- creation unless explicitly revoked) despite having NO internal
-- authorization check at all — no auth.uid() check, no role check, no
-- ownership check. Since PostgREST exposes any function with EXECUTE
-- granted to anon/authenticated as a directly callable RPC
-- (`/rest/v1/rpc/<name>`), every one of these was reachable by any signed-in
-- user (several even by a fully unauthenticated request):
--
--   auto_confirm_payment_from_verifier(payment_id, plan_id, amount_usd)
--     Flips ANY payment row (regardless of owner) from 'pending' straight to
--     'confirmed', with the caller choosing plan_id/amount_usd. Combined
--     with the pre-existing "Users can insert own payments" RLS policy
--     (which lets any authenticated user create their own pending crypto
--     payment row with an arbitrary plan_id/amount_usd) and the
--     payments_auto_issue_key trigger (which mints a real API key the
--     instant a payment becomes 'confirmed'), this was a direct, zero-cost
--     path to a full paid-plan API key for any signed-in account — worse
--     than the studio-time-theft concern that prompted this audit, since it
--     bypasses payment entirely, not just extends time on an existing key.
--
--   record_discount_redemption(code, user_id, payment_id, discount_amount)
--     Records a discount redemption (and increments times_redeemed) for any
--     code/user/payment/amount combination the caller supplies, with no
--     ownership or validity check.
--
--   export_auth_users_for_backup / export_auth_identities_for_backup /
--   export_auth_mfa_factors_for_backup / export_auth_sessions_for_backup
--     Dump auth.users (email, phone, metadata, ban status),
--     auth.identities, auth.mfa_factors, and auth.sessions (including IP +
--     user agent) respectively — meant only for the daily-db-backup edge
--     function (which calls these via a service-role client), but reachable
--     by ANY caller including a fully unauthenticated one. This was a
--     complete, unauthenticated PII dump of the entire user base.
--
--   export_cron_jobs_for_backup / export_cron_recent_runs_for_backup /
--   export_migrations_for_backup / export_pgmq_queues_for_backup /
--   export_realtime_publication_for_backup / export_schema_ddl_for_backup /
--   export_storage_buckets_for_backup / list_public_tables_for_backup
--     Same pattern, lower sensitivity (infra/schema metadata rather than
--     user PII) but still meant for service-role-only backup use, not
--     public exposure — useful recon for an attacker regardless.
--
--   set_internal_service_key(p_key)
--     Overwrites the vault secret that cron jobs use to authenticate to
--     edge functions, with a value the caller fully controls, no auth
--     check. Any caller could corrupt it, breaking the reconcile/backup/
--     email-queue cron jobs (denial of service on internal automation).
--
-- All of these already have their own independent grant to `service_role`
-- (confirmed before writing this migration), and every legitimate caller
-- (daily-db-backup, verify-crypto-payment, sync-internal-service-key, the
-- payments/discount trigger paths) already uses a service-role client —
-- so revoking PUBLIC/anon/authenticated access does not break any existing
-- legitimate flow.
REVOKE EXECUTE ON FUNCTION public.auto_confirm_payment_from_verifier(uuid, uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_discount_redemption(text, uuid, uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.export_auth_users_for_backup() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.export_auth_identities_for_backup() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.export_auth_mfa_factors_for_backup() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.export_auth_sessions_for_backup() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.export_cron_jobs_for_backup() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.export_cron_recent_runs_for_backup() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.export_migrations_for_backup() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.export_pgmq_queues_for_backup() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.export_realtime_publication_for_backup() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.export_schema_ddl_for_backup() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.export_storage_buckets_for_backup() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.list_public_tables_for_backup() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_internal_service_key(text) FROM PUBLIC, anon, authenticated;
