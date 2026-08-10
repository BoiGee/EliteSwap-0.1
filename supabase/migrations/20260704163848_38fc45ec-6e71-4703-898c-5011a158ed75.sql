
-- Admin/sec_admin audit log
CREATE TABLE IF NOT EXISTS public.admin_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID,
  actor_email TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  before_data JSONB,
  after_data JSONB,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.admin_audit_logs TO authenticated;
GRANT ALL ON public.admin_audit_logs TO service_role;

ALTER TABLE public.admin_audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff can read audit logs" ON public.admin_audit_logs;
CREATE POLICY "Staff can read audit logs"
  ON public.admin_audit_logs FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'sec_admin')
  );

CREATE INDEX IF NOT EXISTS admin_audit_logs_created_idx ON public.admin_audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_logs_actor_idx ON public.admin_audit_logs (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_logs_target_idx ON public.admin_audit_logs (target_type, target_id);

-- Helper: capture actor context from the current JWT / session
CREATE OR REPLACE FUNCTION public.log_admin_action(
  _action TEXT,
  _target_type TEXT,
  _target_id TEXT,
  _before JSONB,
  _after JSONB,
  _metadata JSONB DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid UUID := auth.uid();
  email TEXT;
  role_label TEXT;
BEGIN
  IF uid IS NULL THEN
    -- system / service_role: still record
    role_label := 'system';
  ELSE
    SELECT p.email INTO email FROM public.profiles p WHERE p.user_id = uid LIMIT 1;
    IF public.has_role(uid, 'admin') THEN role_label := 'admin';
    ELSIF public.has_role(uid, 'sec_admin') THEN role_label := 'sec_admin';
    ELSIF public.has_role(uid, 'moderator') THEN role_label := 'moderator';
    ELSE role_label := 'user';
    END IF;
  END IF;

  INSERT INTO public.admin_audit_logs
    (actor_id, actor_email, actor_role, action, target_type, target_id, before_data, after_data, metadata)
  VALUES
    (uid, email, role_label, _action, _target_type, _target_id, _before, _after, COALESCE(_metadata, '{}'::jsonb));
END;
$$;

-- Generic trigger: audits payments, discount_codes, user_roles
CREATE OR REPLACE FUNCTION public.audit_row_change() RETURNS trigger
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
    -- Special-case: status transitions on payments
    IF target = 'payments' AND OLD.status IS DISTINCT FROM NEW.status THEN
      action_name := 'payments.status.' || NEW.status;
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

-- Attach triggers
DROP TRIGGER IF EXISTS audit_payments ON public.payments;
CREATE TRIGGER audit_payments
AFTER INSERT OR UPDATE OR DELETE ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();

DROP TRIGGER IF EXISTS audit_discount_codes ON public.discount_codes;
CREATE TRIGGER audit_discount_codes
AFTER INSERT OR UPDATE OR DELETE ON public.discount_codes
FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();

DROP TRIGGER IF EXISTS audit_user_roles ON public.user_roles;
CREATE TRIGGER audit_user_roles
AFTER INSERT OR UPDATE OR DELETE ON public.user_roles
FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();

DROP TRIGGER IF EXISTS audit_api_keys ON public.api_keys;
CREATE TRIGGER audit_api_keys
AFTER INSERT OR UPDATE OR DELETE ON public.api_keys
FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();

DROP TRIGGER IF EXISTS audit_pricing_plans ON public.pricing_plans;
CREATE TRIGGER audit_pricing_plans
AFTER INSERT OR UPDATE OR DELETE ON public.pricing_plans
FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();
