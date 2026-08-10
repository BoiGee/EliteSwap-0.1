UPDATE auth.users
SET email = 'admin@eliteswap.online',
    email_confirmed_at = COALESCE(email_confirmed_at, now()),
    email_change = '',
    email_change_token_new = '',
    email_change_token_current = '',
    raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('email', 'admin@eliteswap.online'),
    updated_at = now()
WHERE id = '6b536588-44c9-4986-b64f-8824454dc06f';