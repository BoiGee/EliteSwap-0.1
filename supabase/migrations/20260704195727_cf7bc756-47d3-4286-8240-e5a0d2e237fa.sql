CREATE OR REPLACE FUNCTION public.audit_row_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target TEXT;
  tid TEXT;
  action_name TEXT;
  before_j JSONB;
  after_j JSONB;
  old_status TEXT;
  new_status TEXT;
BEGIN
  target := TG_TABLE_NAME;
  IF TG_OP = 'INSERT' THEN
    action_name := target || '.create';
    before_j := NULL;
    after_j := to_jsonb(NEW);
    tid := COALESCE((to_jsonb(NEW)->>'id'), NULL);
  ELSIF TG_OP = 'UPDATE' THEN
    action_name := target || '.update';
    before_j := to_jsonb(OLD);
    after_j := to_jsonb(NEW);
    tid := COALESCE((to_jsonb(NEW)->>'id'), NULL);
    IF target = 'payments' THEN
      old_status := before_j->>'status';
      new_status := after_j->>'status';
      IF old_status IS DISTINCT FROM new_status AND new_status IS NOT NULL THEN
        action_name := 'payments.status.' || new_status;
      END IF;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    action_name := target || '.delete';
    before_j := to_jsonb(OLD);
    after_j := NULL;
    tid := COALESCE((to_jsonb(OLD)->>'id'), NULL);
  END IF;

  PERFORM public.log_admin_action(action_name, target, tid, before_j, after_j, '{}'::jsonb);

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;