CREATE OR REPLACE FUNCTION public.partner_downline_tree(p_partner_id uuid)
RETURNS TABLE(
  partner_id uuid,
  code text,
  display_name text,
  commission_pct numeric,
  is_active boolean,
  parent_partner_id uuid,
  depth integer
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (has_role('admin'::app_role)
          OR EXISTS (SELECT 1 FROM public.partners WHERE id = p_partner_id AND user_id = auth.uid())) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH RECURSIVE chain AS (
    SELECT p.id, p.code, p.display_name, p.commission_pct, p.is_active, p.parent_partner_id, 1 AS depth
      FROM public.partners p
     WHERE p.parent_partner_id = p_partner_id
    UNION ALL
    SELECT p2.id, p2.code, p2.display_name, p2.commission_pct, p2.is_active, p2.parent_partner_id, c.depth + 1
      FROM public.partners p2
      JOIN chain c ON p2.parent_partner_id = c.id
     WHERE c.depth < 20
  )
  SELECT c.id, c.code, c.display_name, c.commission_pct, c.is_active, c.parent_partner_id, c.depth
    FROM chain c
   ORDER BY c.depth, c.code;
END;
$function$;