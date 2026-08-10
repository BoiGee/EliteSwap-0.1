-- admin_manage_trial_purchase() already authorizes admin OR sec_admin
-- (verified against the live function), but trial_purchases' own SELECT
-- policy only granted 'admin' — meaning a sec_admin could call the manage
-- RPC but couldn't see any rows to act on in the first place, and the
-- FinanceManager UI that used to host this (isAdmin-only gate) blocked
-- sec_admin from the whole page regardless. Aligning RLS to match what the
-- RPC already intended, now that this is getting its own admin tab.
DROP POLICY IF EXISTS "Users view own trial purchases" ON public.trial_purchases;
CREATE POLICY "Users view own trial purchases"
  ON public.trial_purchases FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'::app_role) OR public.has_role(auth.uid(), 'sec_admin'::app_role));
