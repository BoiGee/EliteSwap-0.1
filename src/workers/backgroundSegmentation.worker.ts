/// <reference lib="webworker" />
// Off-main-thread person segmentation for the custom studio background
// feature. Runs MediaPipe's ImageSegmenter (selfie multiclass model) on the
// CPU delegate — no GPU dependency — so this never competes with (or
// requires) the device's discrete/integrated graphics, and never blocks the
// main thread's video rendering or UI.
//
// Protocol (see BackgroundSegmentationMessage/Response types below):
//   init  -> loads the WASM runtime + model, replies "ready"
//   frame -> segments one ImageBitmap (transferred, not copied), replies
//            "mask" with a transferable Float32Array confidence mask plus
//            the wall-clock inference time so the caller can adapt its
//            request rate to what this device can actually sustain.

import type { ImageSegmenter as ImageSegmenterType } from "@mediapipe/tasks-vision";

export type BackgroundSegmentationMessage =
  | { kind: "init" }
  | { kind: "frame"; id: number; bitmap: ImageBitmap; timestampMs: number }
  | { kind: "close" };

export type BackgroundSegmentationResponse =
  | { kind: "ready" }
  | { kind: "error"; message: string }
  | {
      kind: "mask";
      id: number;
      mask: Float32Array;
      width: number;
      height: number;
      inferenceMs: number;
    };

let segmenter: ImageSegmenterType | null = null;
let initPromise: Promise<void> | null = null;

async function ensureSegmenter(): Promise<void> {
  if (segmenter) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const { ImageSegmenter, FilesetResolver } = await import("@mediapipe/tasks-vision");
    const fileset = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm",
    );
    segmenter = await ImageSegmenter.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite",
        delegate: "CPU",
      },
      runningMode: "VIDEO",
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    });
  })();
  return initPromise;
}

self.onmessage = async (e: MessageEvent<BackgroundSegmentationMessage>) => {
  const msg = e.data;
  try {
    if (msg.kind === "init") {
      await ensureSegmenter();
      (self as unknown as Worker).postMessage({ kind: "ready" } satisfies BackgroundSegmentationResponse);
      return;
    }

    if (msg.kind === "frame") {
      await ensureSegmenter();
      if (!segmenter) throw new Error("segmenter not initialized");
      const start = performance.now();
      const result = segmenter.segmentForVideo(msg.bitmap, msg.timestampMs);
      const confidence = result.confidenceMasks?.[0];
      if (!confidence) {
        msg.bitmap.close();
        result.close();
        throw new Error("no confidence mask returned");
      }
      // Copy out of the MPMask before it's released — getAsFloat32Array()
      // ties its lifetime to the result object.
      const src = confidence.getAsFloat32Array();
      const mask = new Float32Array(src.length);
      mask.set(src);
      const width = confidence.width;
      const height = confidence.height;
      const inferenceMs = performance.now() - start;
      result.close();
      msg.bitmap.close();
      (self as unknown as Worker).postMessage(
        { kind: "mask", id: msg.id, mask, width, height, inferenceMs } satisfies BackgroundSegmentationResponse,
        [mask.buffer],
      );
      return;
    }

    if (msg.kind === "close") {
      segmenter?.close();
      segmenter = null;
      initPromise = null;
      return;
    }
  } catch (err) {
    if (msg.kind === "frame") {
      try { msg.bitmap.close(); } catch { /* noop */ }
    }
    const message = err instanceof Error ? err.message : "Segmentation failed";
    (self as unknown as Worker).postMessage({ kind: "error", message } satisfies BackgroundSegmentationResponse);
  }
};
