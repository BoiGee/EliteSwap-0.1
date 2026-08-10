/**
 * Reference-image quality gate.
 *
 * Runs entirely in the browser at upload time. Scores a candidate reference
 * photo and classifies it as `pass`, `marginal`, or `blocked`. The studio uses
 * the classification to either upload as-is, silently enhance, or refuse.
 *
 * Nothing here runs during streaming — the live video pipeline is untouched.
 */

export type BlockCode =
  | "too_small"
  | "no_face"
  | "multiple_faces"
  | "too_blurry"
  | "decode_failed";

export type ImageScore = {
  width: number;
  height: number;
  blurScore: number;
  faceCount: number;
  faceBounds: { x: number; y: number; width: number; height: number } | null;
  faceConfidence: number;
  hasFaceDetector: boolean;
  tier: "pass" | "marginal" | "blocked";
  blockCode?: BlockCode;
  reason?: string;
};

// Thresholds — tuned starting values, safe to tweak without touching call sites.
export const THRESH = {
  minLongEdge: 256,
  idealLongEdge: 1024,
  blockBlur: 40,
  marginalBlur: 120,
  minFaceAreaRatio: 0.08,
  minFaceConfidence: 0.5,
} as const;

const REASONS: Record<BlockCode, string> = {
  too_small: `Image too small — please use a photo at least ${THRESH.minLongEdge}×${THRESH.minLongEdge}.`,
  no_face: "No face detected — please use a clear, front-facing photo.",
  multiple_faces: "Multiple faces detected — please use a solo photo.",
  too_blurry: "Image is too blurry — please use a sharper photo.",
  decode_failed: "Could not read this image — please try a different file.",
};

/** Laplacian variance on a downsampled grayscale copy. Higher = sharper. */
function computeBlurScore(bitmap: ImageBitmap): number {
  const target = 256;
  const scale = Math.min(1, target / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(8, Math.round(bitmap.width * scale));
  const h = Math.max(8, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return 999;
  ctx.drawImage(bitmap, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  // Grayscale
  const gray = new Float32Array(w * h);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  // 3x3 Laplacian kernel  [0,1,0; 1,-4,1; 0,1,0]
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v =
        -4 * gray[i] +
        gray[i - 1] +
        gray[i + 1] +
        gray[i - w] +
        gray[i + w];
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

async function detectFaces(bitmap: ImageBitmap): Promise<{
  count: number;
  bounds: ImageScore["faceBounds"];
  confidence: number;
  available: boolean;
}> {
  const FD = (globalThis as any).FaceDetector;
  if (typeof FD !== "function") {
    return { count: 0, bounds: null, confidence: 0, available: false };
  }
  try {
    const detector = new FD({ fastMode: true, maxDetectedFaces: 4 });
    const faces = await detector.detect(bitmap);
    if (!faces || faces.length === 0) {
      return { count: 0, bounds: null, confidence: 0, available: true };
    }
    // Pick the largest face as the primary.
    let best = faces[0];
    let bestArea = best.boundingBox.width * best.boundingBox.height;
    for (const f of faces) {
      const a = f.boundingBox.width * f.boundingBox.height;
      if (a > bestArea) {
        best = f;
        bestArea = a;
      }
    }
    return {
      count: faces.length,
      bounds: {
        x: best.boundingBox.x,
        y: best.boundingBox.y,
        width: best.boundingBox.width,
        height: best.boundingBox.height,
      },
      confidence: 1, // FaceDetector doesn't expose a score — treat detection as confident.
      available: true,
    };
  } catch {
    return { count: 0, bounds: null, confidence: 0, available: false };
  }
}

export async function scoreImage(file: File): Promise<ImageScore> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return {
      width: 0,
      height: 0,
      blurScore: 0,
      faceCount: 0,
      faceBounds: null,
      faceConfidence: 0,
      hasFaceDetector: false,
      tier: "blocked",
      blockCode: "decode_failed",
      reason: REASONS.decode_failed,
    };
  }

  const width = bitmap.width;
  const height = bitmap.height;
  const longEdge = Math.max(width, height);
  const imageArea = width * height;

  const blurScore = computeBlurScore(bitmap);
  const face = await detectFaces(bitmap);
  try { bitmap.close(); } catch { /* noop */ }

  // ---- Block conditions ----
  if (longEdge < THRESH.minLongEdge) {
    return score("blocked", "too_small");
  }
  if (blurScore < THRESH.blockBlur) {
    return score("blocked", "too_blurry");
  }
  if (face.available) {
    if (face.count === 0) return score("blocked", "no_face");
    if (face.count > 1) return score("blocked", "multiple_faces");
  }

  // ---- Marginal conditions ----
  let marginal = false;
  if (longEdge < THRESH.idealLongEdge) marginal = true;
  if (blurScore < THRESH.marginalBlur) marginal = true;
  if (face.bounds) {
    const faceArea = face.bounds.width * face.bounds.height;
    if (faceArea / imageArea < THRESH.minFaceAreaRatio) marginal = true;
  }

  return score(marginal ? "marginal" : "pass");

  function score(tier: ImageScore["tier"], blockCode?: BlockCode): ImageScore {
    return {
      width,
      height,
      blurScore,
      faceCount: face.count,
      faceBounds: face.bounds,
      faceConfidence: face.confidence,
      hasFaceDetector: face.available,
      tier,
      blockCode,
      reason: blockCode ? REASONS[blockCode] : undefined,
    };
  }
}
