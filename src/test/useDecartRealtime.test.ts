import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useDecartRealtime } from "@/hooks/useDecartRealtime";

// jsdom implements neither 2D canvas rendering nor HTMLCanvasElement.captureStream.
// Stub both so the preview-canvas code path (the thing that actually produces the
// "footage" fed into the output console) can run and be inspected headlessly.
function stubCanvas() {
  const ctxCalls: string[] = [];
  const fakeCtx = {
    clearRect: () => ctxCalls.push("clearRect"),
    fillRect: () => ctxCalls.push("fillRect"),
    drawImage: () => ctxCalls.push("drawImage"),
    fillText: (text: string) => ctxCalls.push(`fillText:${text}`),
    set fillStyle(_v: string) {},
    set font(_v: string) {},
    set textAlign(_v: string) {},
  };

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => fakeCtx as unknown as CanvasRenderingContext2D);
  // jsdom has no captureStream implementation at all (not even a stub to spy on).
  (HTMLCanvasElement.prototype as any).captureStream = () => ({ getTracks: () => [] }) as unknown as MediaStream;

  return ctxCalls;
}

describe("useDecartRealtime — output console without an API key", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("still renders a frame into previewStream when the Decart API key is missing", async () => {
    const ctxCalls = stubCanvas();
    const { result } = renderHook(() => useDecartRealtime());

    let submitResult: Awaited<ReturnType<typeof result.current.applyStudioRequest>>;
    await act(async () => {
      submitResult = await result.current.applyStudioRequest({
        prompt: "Enhance the video slightly",
        mode: "preview",
      });
    });

    // The engine fell back because no API key is configured anywhere.
    expect(submitResult!.metadata.offline_fallback).toBe(true);
    expect(submitResult!.error).toContain("Missing API key");

    // The output console still got fed an actual frame (drawn onto the
    // preview canvas) instead of staying blank.
    expect(result.current.previewStream).not.toBeNull();
    expect(result.current.connectionState).toBe("preview_loop");
    expect(ctxCalls.some((c) => c.includes("fillText") && c.includes("fallback mode"))).toBe(true);
  });
});
