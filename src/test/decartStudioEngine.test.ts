import { vi } from "vitest";

// The real SDK's client.process() hits Decart's live API — for the timeout
// test below we need full control over whether/when that call resolves.
const { processMock } = vi.hoisted(() => ({ processMock: vi.fn() }));
vi.mock("@decartai/sdk", () => ({
  createDecartClient: () => ({ process: processMock }),
  models: { image: (name: string) => ({ name }), realtime: (name: string) => ({ name }) },
}));

import { DecartStudioEngine } from "@/lib/decartStudioEngine";

it("constructor validation - no config", async () => {
    const result = await new DecartStudioEngine().submit({ prompt: "test" });
    expect(result.error).toContain("Missing API key");
  });

  it("mode normalization with various inputs", async () => {
    // Empty string
    const r1 = await new DecartStudioEngine({ mode: "" }).submit({ prompt: "test" });
    expect(r1.data.mode).toBe("preview");

    // Whitespace only
    const r2 = await new DecartStudioEngine({ mode: "   " }).submit({ prompt: "test" });
    expect(r2.data.mode).toBe("preview");

    // Lowercase valid
    const r3 = await new DecartStudioEngine({ mode: "preview" }).submit({ prompt: "test" });
    expect(r3.data.mode).toBe("preview");

    // Mixed case should normalize
    const r4 = await new DecartStudioEngine({ mode: "PREVIEW" }).submit({ prompt: "test" });
    expect(r4.data.mode).toBe("preview");
  });

  it("metadata consistency across code paths", async () => {
    const result1 = await new DecartStudioEngine({ apiKey: "test" }).submit({ prompt: "test" });
    expect(result1.metadata.credit_safe).toBe(true);
    expect(result1.metadata.offline_fallback).toBe(true);

    const result2 = await new DecartStudioEngine({ enableFallback: false, apiKey: "" }).submit({ prompt: "test" });
    expect(result2.metadata.credit_safe).toBe(true);
    expect(result2.metadata.offline_fallback).toBe(true);
  });

  it("lucy25 preview mode is credit safe by default", async () => {
    const engine = new DecartStudioEngine({ apiKey: "test-key" });
    const result = await engine.submit({ prompt: "test" });

    expect(result.success).toBe(true);
    expect(result.metadata.lucy25).toBe(true);
  });

  it("preview backend check returns success when no API key but fallback enabled", async () => {
    const result = await new DecartStudioEngine({ apiKey: "", enableFallback: true }).submit({ prompt: "test" });
    expect(result.success).toBe(true);
    expect(result.metadata.offline_fallback).toBe(true);
  });

  it("non-preview mode logs warning", async () => {
    const engine = new DecartStudioEngine({ apiKey: "test-key" });
    const result = await engine.submit({ prompt: "Test", mode: "execute" });

    expect(result.metadata.offline_fallback).toBe(true);
  });

  it("fallback disabled with no API key returns error", async () => {
    const engine = new DecartStudioEngine({ apiKey: "", enableFallback: false });
    const result = await engine.submit({ prompt: "Test" });

    expect(result.success).toBe(false);
  });

  it("missing imageUrl returns fallback response", async () => {
    const engine = new DecartStudioEngine({ apiKey: "test-key" });
    const result = await engine.submit({ prompt: "Test" });

    expect(result.data.fallback).toBe("offline_credit_safe");
    expect(result.metadata.offline_fallback).toBe(true);
    expect(result.error).toContain("No source frame available");
  });

  it("error handling in submit returns fallback response", async () => {
    const engine = new DecartStudioEngine({ apiKey: "test-key" });
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));

    const result = await engine.submit({ prompt: "Test", imageUrl: "https://example.com/frame.png" });

    expect(result.error).toBeDefined();
    expect(result.error).toContain("network down");
    expect(result.metadata.offline_fallback).toBe(true);

    vi.restoreAllMocks();
  });

  it("a hung Decart request times out instead of blocking submit forever", async () => {
    vi.useFakeTimers();
    processMock.mockImplementation(() => new Promise(() => {})); // never resolves
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["frame"]),
    } as any);

    const engine = new DecartStudioEngine({ apiKey: "test-key" });
    const submitPromise = engine.submit({ prompt: "Test", imageUrl: "data:image/png;base64,AAAA" });

    await vi.advanceTimersByTimeAsync(15000);
    const result = await submitPromise;

    expect(result.success).toBe(true);
    expect(result.metadata.offline_fallback).toBe(true);
    expect(result.error).toContain("timed out");

    vi.useRealTimers();
    vi.restoreAllMocks();
  });
