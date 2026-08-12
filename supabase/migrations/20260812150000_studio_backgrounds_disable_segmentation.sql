-- "AI Background" (segmentation mode) cannot work on this deployment at
-- all: MediaPipe's WASM runtime needs SharedArrayBuffer, which needs
-- Cross-Origin-Opener-Policy/Cross-Origin-Embedder-Policy response headers,
-- and GitHub Pages has no way to serve custom headers. Confirmed directly —
-- segmenter creation only succeeds with those headers present locally;
-- every real session on the live site is missing them and fails with
-- "ModuleFactory not set". The client no longer offers segmentation mode
-- (StudioBackgroundPanel.tsx) and forces chromakey regardless of what's
-- stored, but the column's default was still 'segmentation' — meaning any
-- row inserted before that client fix (or by any other path) would still
-- carry the broken value. Fixing at the data layer too so nothing depends
-- on the client-side override alone.
ALTER TABLE public.studio_backgrounds
  ALTER COLUMN mode SET DEFAULT 'chromakey';

UPDATE public.studio_backgrounds
   SET mode = 'chromakey',
       chroma_key_color = COALESCE(chroma_key_color, '#00b140')
 WHERE mode = 'segmentation';
