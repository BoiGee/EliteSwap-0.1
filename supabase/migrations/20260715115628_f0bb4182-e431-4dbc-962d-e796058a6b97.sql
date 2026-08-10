
-- 1) Remove api_keys from realtime to stop broadcasting raw key column
ALTER PUBLICATION supabase_realtime DROP TABLE public.api_keys;

-- 2) Remove user-facing SELECT on free_trial_keys (no client code reads it;
-- users get their trial key through the api_keys row they own)
DROP POLICY IF EXISTS "Users can view own claimed trial keys" ON public.free_trial_keys;

-- 3) Consolidate duplicate admin/payment-manager policies on payments
DROP POLICY IF EXISTS "Admins can view all payments" ON public.payments;
DROP POLICY IF EXISTS "Admins can insert payments" ON public.payments;
DROP POLICY IF EXISTS "Admins can update payments" ON public.payments;
DROP POLICY IF EXISTS "Admins can delete payments" ON public.payments;

-- 4) Consolidate duplicate admin/discount-manager policies on discount_codes
DROP POLICY IF EXISTS "Admins can view discount codes" ON public.discount_codes;
DROP POLICY IF EXISTS "Admins can insert discount codes" ON public.discount_codes;
DROP POLICY IF EXISTS "Admins can update discount codes" ON public.discount_codes;
DROP POLICY IF EXISTS "Admins can delete discount codes" ON public.discount_codes;

-- 5) Consolidate duplicate admin/payment-manager policies on payment_nudge_history
DROP POLICY IF EXISTS "Admins view nudge history" ON public.payment_nudge_history;
DROP POLICY IF EXISTS "Admins can insert nudges" ON public.payment_nudge_history;
DROP POLICY IF EXISTS "Admins insert nudge history" ON public.payment_nudge_history;
