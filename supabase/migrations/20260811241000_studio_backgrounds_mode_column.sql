-- Each saved background remembers its own compositing mode (AI segmentation
-- vs. chroma-key) and, for chroma-key, the key color to match — set at
-- upload/edit time in the studio panel, not a global toggle, since a user
-- with a physical green screen and a user relying on AI segmentation are
-- both picking per-image, not per-account.
ALTER TABLE public.studio_backgrounds
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'segmentation'
    CHECK (mode IN ('segmentation', 'chromakey')),
  ADD COLUMN IF NOT EXISTS chroma_key_color text;
