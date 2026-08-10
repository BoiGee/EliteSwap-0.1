/**
 * Reference-image auto-enhance.
 *
 * Given a marginal-tier image and its score, produce a cleaner version:
 *   - crop around the detected face (if any) with generous padding
 *   - upscale so the long edge reaches TARGET_LONG_EDGE
 *   - light unsharp mask
 *   - re-encode as high-quality JPEG
 *
 * Runs once at upload time. Zero per-frame cost.
 */
import type { ImageScore } from "./referenceImageGate";

const TARGET_LONG_EDGE = 1024;

export async function enhanceImage(file: File, score: ImageScore): Promise<File> {
  const bitmap = await createImageBitmap(file);

  // 1. Choose a crop rect (face-centered with padding to include shoulders/torso)
  //    or the full frame. Wider padding gives Lucy visible outfit context to
  //    carry into the output — a face-only crop leaves the model guessing.
  let sx = 0, sy = 0, sw = bitmap.width, sh = bitmap.height;
  if (score.faceBounds) {
    const fb = score.faceBounds;
    const padX = 0.55;
    const padTop = 0.35;
    const padBottom = 1.4; // extend downward to catch shoulders + upper torso
    const cx = fb.x + fb.width / 2;
    const w = fb.width * (1 + padX * 2);
    const topY = fb.y - fb.height * padTop;
    const botY = fb.y + fb.height * (1 + padBottom);
    const h = botY - topY;
    const side = Math.max(w, h);
    const cy = (topY + botY) / 2;
    sx = Math.max(0, Math.round(cx - side / 2));
    sy = Math.max(0, Math.round(cy - side / 2));
    sw = Math.min(bitmap.width - sx, Math.round(side));
    sh = Math.min(bitmap.height - sy, Math.round(side));
  }

  // 2. Compute output size (upscale long edge to target).
  const cropLong = Math.max(sw, sh);
  const scale = Math.max(1, TARGET_LONG_EDGE / cropLong);
  const dw = Math.round(sw * scale);
  const dh = Math.round(sh * scale);

  const canvas = document.createElement("canvas");
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    try { bitmap.close(); } catch { /* noop */ }
    return file;
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, dw, dh);
  try { bitmap.close(); } catch { /* noop */ }

  // 3. Exposure / contrast normalization via a per-channel histogram stretch.
  //    Cheap, deterministic, and rescues under/over-exposed selfies before we
  //    hand them to the identity encoder.
  normalizeExposure(ctx, dw, dh);

  // 4. Light unsharp mask via convolution: blend original with a sharpen kernel.
  applyUnsharpMask(ctx, dw, dh);

  // 5. Re-encode as JPEG.
  const blob: Blob = await new Promise((resolve) => {
    canvas.toBlob(
      (b) => resolve(b ?? new Blob([])),
      "image/jpeg",
      0.95,
    );
  });

  const outName = file.name.replace(/\.[^.]+$/, "") + "_enhanced.jpg";
  return new File([blob], outName, { type: "image/jpeg" });
}

/** Mild sharpen: 3x3 kernel with center 5, edges -1 (normalized). */
function applyUnsharpMask(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const img = ctx.getImageData(0, 0, w, h);
  const src = img.data;
  const out = new Uint8ClampedArray(src.length);
  const kernel = [0, -1, 0, -1, 5, -1, 0, -1, 0];
  const strength = 0.35; // blend factor toward sharpened
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        let k = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const idx = ((y + ky) * w + (x + kx)) * 4 + c;
            sum += src[idx] * kernel[k++];
          }
        }
        out[i + c] = src[i + c] * (1 - strength) + sum * strength;
      }
      out[i + 3] = src[i + 3];
    }
  }
  // Copy borders untouched
  for (let x = 0; x < w; x++) {
    for (const y of [0, h - 1]) {
      const i = (y * w + x) * 4;
      out[i] = src[i]; out[i + 1] = src[i + 1]; out[i + 2] = src[i + 2]; out[i + 3] = src[i + 3];
    }
  }
  for (let y = 0; y < h; y++) {
    for (const x of [0, w - 1]) {
      const i = (y * w + x) * 4;
      out[i] = src[i]; out[i + 1] = src[i + 1]; out[i + 2] = src[i + 2]; out[i + 3] = src[i + 3];
    }
  }
  ctx.putImageData(new ImageData(out, w, h), 0, 0);
}

/**
 * Per-channel histogram stretch. Finds the 2nd and 98th percentile per RGB
 * channel and remaps them to 0..255, giving underexposed / low-contrast
 * selfies a clean dynamic range without introducing visible color casts.
 */
function normalizeExposure(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let i = 0; i < d.length; i += 4) {
    hist[0][d[i]]++;
    hist[1][d[i + 1]]++;
    hist[2][d[i + 2]]++;
  }
  const total = w * h;
  const loCut = Math.floor(total * 0.02);
  const hiCut = Math.floor(total * 0.98);
  const lo = [0, 0, 0];
  const hi = [255, 255, 255];
  for (let c = 0; c < 3; c++) {
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[c][v];
      if (acc >= loCut) { lo[c] = v; break; }
    }
    acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[c][v];
      if (acc >= hiCut) { hi[c] = v; break; }
    }
  }
  const lut = [new Uint8ClampedArray(256), new Uint8ClampedArray(256), new Uint8ClampedArray(256)];
  for (let c = 0; c < 3; c++) {
    const span = Math.max(1, hi[c] - lo[c]);
    for (let v = 0; v < 256; v++) {
      const stretched = ((v - lo[c]) * 255) / span;
      lut[c][v] = stretched < 0 ? 0 : stretched > 255 ? 255 : stretched;
    }
  }
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[0][d[i]];
    d[i + 1] = lut[1][d[i + 1]];
    d[i + 2] = lut[2][d[i + 2]];
  }
  ctx.putImageData(img, 0, 0);
}
