-- TrialPurchaseManager subscribes to postgres_changes on trial_purchases so
-- the new $10 Trials tab updates live when a payment webhook/cron confirms
-- or fails a purchase with zero admin action involved — same reasoning as
-- the payments/api_keys/profiles realtime additions already made.
ALTER PUBLICATION supabase_realtime ADD TABLE public.trial_purchases;
