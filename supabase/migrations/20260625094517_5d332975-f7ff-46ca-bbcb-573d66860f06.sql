
-- 1) Lock down raw SELECT on forum_reactions
DROP POLICY IF EXISTS "reactions readable" ON public.forum_reactions;

CREATE POLICY "reactions self or admin readable"
ON public.forum_reactions
FOR SELECT
USING (
  auth.uid() = user_id
  OR has_role(auth.uid(), 'admin'::app_role)
);

-- 2) Public-safe counts via SECURITY DEFINER function
CREATE OR REPLACE FUNCTION public.forum_reaction_counts(
  _target_kind text,
  _target_id uuid
)
RETURNS TABLE(emoji text, count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _cat_id uuid;
  _hidden timestamptz;
BEGIN
  IF _target_kind = 'thread' THEN
    SELECT category_id, hidden_at INTO _cat_id, _hidden
    FROM public.forum_threads WHERE id = _target_id;
  ELSIF _target_kind = 'reply' THEN
    SELECT t.category_id, COALESCE(r.hidden_at, t.hidden_at)
      INTO _cat_id, _hidden
    FROM public.forum_replies r
    JOIN public.forum_threads t ON t.id = r.thread_id
    WHERE r.id = _target_id;
  ELSE
    RETURN;
  END IF;

  IF _cat_id IS NULL OR _hidden IS NOT NULL THEN
    RETURN;
  END IF;

  IF NOT public.forum_can_view_category(_cat_id) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT fr.emoji, COUNT(*)::bigint
  FROM public.forum_reactions fr
  WHERE fr.target_kind::text = _target_kind
    AND fr.target_id = _target_id
  GROUP BY fr.emoji;
END;
$$;

REVOKE ALL ON FUNCTION public.forum_reaction_counts(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.forum_reaction_counts(text, uuid) TO anon, authenticated;
