-- Replace admin email everywhere
UPDATE auth.users
SET email = 'elitetoolz@outlook.com',
    raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('email', 'elitetoolz@outlook.com')
WHERE email = 'admin@eliteswap.online';

UPDATE auth.identities
SET identity_data = identity_data || jsonb_build_object('email', 'elitetoolz@outlook.com')
WHERE identity_data->>'email' = 'admin@eliteswap.online';

UPDATE public.profiles SET email = 'elitetoolz@outlook.com' WHERE email = 'admin@eliteswap.online';
UPDATE public.email_send_log SET recipient_email = 'elitetoolz@outlook.com' WHERE recipient_email = 'admin@eliteswap.online';
UPDATE public.email_unsubscribe_tokens SET email = 'elitetoolz@outlook.com' WHERE email = 'admin@eliteswap.online';
UPDATE public.broadcast_recipients SET email = 'elitetoolz@outlook.com' WHERE email = 'admin@eliteswap.online';
UPDATE public.terms_acceptances SET email = 'elitetoolz@outlook.com' WHERE email = 'admin@eliteswap.online';
UPDATE public.account_deletion_requests SET email = 'elitetoolz@outlook.com' WHERE email = 'admin@eliteswap.online';
-- Remove any suppression on the new admin email so it can receive mail
DELETE FROM public.suppressed_emails WHERE email = 'elitetoolz@outlook.com';
DELETE FROM public.suppressed_emails WHERE email = 'admin@eliteswap.online';