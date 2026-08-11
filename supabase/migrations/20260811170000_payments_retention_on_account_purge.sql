-- Per explicit decision: payment/transaction records survive account
-- deletion, anonymized, instead of being hard-deleted. Previously
-- payments.user_id -> auth.users was ON DELETE CASCADE, so the purge
-- pipeline's account_deletion wiped the row entirely (whether or not the
-- edge function's own loop explicitly deleted it — the FK cascade would
-- have destroyed it regardless the moment auth.admin.deleteUser() ran).
-- That silently erased real revenue history and, as a side effect,
-- CASCADE-deleted partner_override_earnings rows for anyone this
-- payment had generated referral commission for — someone else's
-- rightfully-earned, already-tracked commission, destroyed just because
-- the paying customer later deleted their own account. Verified this
-- hasn't actually happened yet (none of the 49 real purges to date ever
-- touched a confirmed payment), but it was one paying customer's deletion
-- request away from happening.
--
-- Switched to ON DELETE SET NULL: the payment row (amount, date, status,
-- plan) survives for accounting, fully anonymized (no other column on
-- payments identifies the person), and partner_override_earnings tied to
-- it is no longer collateral damage since its parent row no longer gets
-- deleted. "Users can view own payments" RLS already keys off
-- auth.uid() = user_id, which can never match NULL, so an anonymized
-- payment is correctly invisible to any end user going forward — visible
-- only to staff via can_manage_payments().

ALTER TABLE public.payments ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE public.payments DROP CONSTRAINT payments_user_id_fkey;
ALTER TABLE public.payments
  ADD CONSTRAINT payments_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
