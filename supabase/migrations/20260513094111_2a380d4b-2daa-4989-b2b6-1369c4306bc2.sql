ALTER VIEW public.reviews_public SET (security_invoker=off);
GRANT SELECT ON public.reviews_public TO anon, authenticated;