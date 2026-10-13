-- OGateway merchant calls go to customer-api.ogateway.io (api.ogateway.io rejects every
-- request at its load balancer). Let the database relay call either host.
CREATE OR REPLACE FUNCTION public.og_http_queue(p_method text, p_url text, p_auth text, p_body jsonb DEFAULT NULL)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net
AS $$
BEGIN
  IF p_url NOT LIKE 'https://api.ogateway.io/%' AND p_url NOT LIKE 'https://customer-api.ogateway.io/%' THEN
    RAISE EXCEPTION 'og_http_queue only calls OGateway';
  END IF;
  IF upper(p_method) = 'GET' THEN
    RETURN net.http_get(url := p_url, headers := jsonb_build_object('Authorization', p_auth), timeout_milliseconds := 20000);
  END IF;
  RETURN net.http_post(url := p_url, body := COALESCE(p_body, '{}'::jsonb),
    headers := jsonb_build_object('Authorization', p_auth, 'Content-Type', 'application/json'),
    timeout_milliseconds := 20000);
END;
$$;
REVOKE ALL ON FUNCTION public.og_http_queue(text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.og_http_queue(text, text, text, jsonb) TO service_role;
