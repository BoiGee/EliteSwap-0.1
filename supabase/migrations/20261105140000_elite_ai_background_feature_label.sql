-- The in-browser AI / green-screen background was replaced by the Elite AI background (Vidu).
-- Feature wording only; prices and everything else on the plans are unchanged.
UPDATE public.pricing_plans
   SET features = array_replace(features, 'Custom Studio Background (AI or Green Screen)', 'Elite AI Background')
 WHERE 'Custom Studio Background (AI or Green Screen)' = ANY(features);
