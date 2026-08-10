
-- Auto-fulfill pending key assignments when new pool keys become available
CREATE OR REPLACE FUNCTION public.tg_api_key_pool_fulfill_pending()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_payment_id uuid;
BEGIN
  IF NEW.status <> 'available' THEN
    RETURN NEW;
  END IF;

  -- Prefer a pending payment whose plan matches this key's plan; if the
  -- key is unbound (plan_id IS NULL), match the oldest pending payment of any plan.
  SELECT p.id INTO v_payment_id
  FROM public.payments p
  WHERE p.status = 'confirmed'
    AND p.pending_key_assignment = true
    AND (NEW.plan_id IS NULL OR p.plan_id = NEW.plan_id)
    AND NOT EXISTS (SELECT 1 FROM public.api_keys k WHERE k.payment_id = p.id)
  ORDER BY p.created_at ASC
  LIMIT 1;

  IF v_payment_id IS NOT NULL THEN
    PERFORM public.issue_api_key_for_payment(v_payment_id);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_api_key_pool_fulfill_pending_ins ON public.api_key_pool;
CREATE TRIGGER trg_api_key_pool_fulfill_pending_ins
AFTER INSERT ON public.api_key_pool
FOR EACH ROW EXECUTE FUNCTION public.tg_api_key_pool_fulfill_pending();

DROP TRIGGER IF EXISTS trg_api_key_pool_fulfill_pending_upd ON public.api_key_pool;
CREATE TRIGGER trg_api_key_pool_fulfill_pending_upd
AFTER UPDATE OF status ON public.api_key_pool
FOR EACH ROW
WHEN (NEW.status = 'available' AND OLD.status IS DISTINCT FROM 'available')
EXECUTE FUNCTION public.tg_api_key_pool_fulfill_pending();
