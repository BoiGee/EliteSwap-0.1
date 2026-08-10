-- Deep scan safe fixes (Phase 1): FKs, unique indexes, policy tweak.

-- 1. Add ON DELETE CASCADE FKs to auth.users where missing.
ALTER TABLE public.discount_redemptions
  ADD CONSTRAINT discount_redemptions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.partner_attributions
  ADD CONSTRAINT partner_attributions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.terms_acceptances
  ADD CONSTRAINT terms_acceptances_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.payment_nudge_history
  ADD CONSTRAINT payment_nudge_history_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- 2. Unique index: one redemption per (user, code).
CREATE UNIQUE INDEX IF NOT EXISTS idx_discount_redemptions_user_code
  ON public.discount_redemptions(user_id, code_id);

-- 3. Unique partial index: one confirmed crypto payment per real tx hash.
-- Only enforced for hash strings that look like real chain hashes (>= 60 chars),
-- avoiding false collisions on legacy placeholder values like "momo".
CREATE UNIQUE INDEX IF NOT EXISTS payments_tx_hash_confirmed_unique
  ON public.payments (lower(tx_hash))
  WHERE status = 'confirmed'
    AND payment_method = 'crypto'
    AND tx_hash IS NOT NULL
    AND length(tx_hash) >= 60;

-- 4. Broaden payment_nudge_history INSERT policy so service-role nudges
-- (sent_by NULL) succeed while admin UI still checks auth.uid = sent_by.
DROP POLICY IF EXISTS "Admins can insert nudges" ON public.payment_nudge_history;
CREATE POLICY "Admins can insert nudges" ON public.payment_nudge_history
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_role(auth.uid(), 'admin'::app_role)
    AND (sent_by IS NULL OR sent_by = auth.uid())
  );