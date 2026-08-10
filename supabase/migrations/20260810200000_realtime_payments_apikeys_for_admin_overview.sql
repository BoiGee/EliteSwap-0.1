-- Same class of gap as the Total Users tally (20260810180000): the admin
-- Overview tab's Pending Payments / Confirmed Payments / Active API Keys
-- stats, the Recent Payments list, and the sidebar's pending-payments badge
-- all read from Admin.tsx's payments/apiKeys state, which only refreshes on
-- mount or after the admin's own mutations (updatePaymentStatus,
-- toggleApiKey, etc). Verified only "profiles" was in the realtime
-- publication — payments and api_keys change constantly from fully
-- automated processes with no admin action involved (Paystack webhook,
-- crypto payment cron, key deactivation on exhaustion via heartbeat/reaper),
-- so an admin sitting on the Overview tab would not see a new pending
-- payment appear, including the badge meant to draw their attention to it.
ALTER PUBLICATION supabase_realtime ADD TABLE public.payments;
ALTER PUBLICATION supabase_realtime ADD TABLE public.api_keys;
