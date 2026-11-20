import { describe, expect, it } from "vitest";
import { brandMessage, mentionsProvider } from "./brandMessage";

const FALLBACK = "Couldn't connect to the Elite Swap studio. Please try again.";

describe("brandMessage", () => {
  it("replaces anything naming a provider or its SDK", () => {
    for (const m of [
      "Vidu rejected the session request",
      "Could not reach Vidu",
      "No active Vidu key in the pool",
      "Failed to connect to Decart realtime",
      "AliRTC join failed",
      "aliyun-rtc-sdk: token expired",
    ]) expect(brandMessage(m, FALLBACK)).toBe(FALLBACK);
  });

  it("replaces raw technical text", () => {
    expect(brandMessage("error: code = 400 reason = BadRequest message = live already ended metadata = map[]", FALLBACK)).toBe(FALLBACK);
    expect(brandMessage("Edge Function returned a non-2xx status code", FALLBACK)).toBe(FALLBACK);
    expect(brandMessage("join failed 0x01020204", FALLBACK)).toBe(FALLBACK);
  });

  it("keeps our own user-facing copy", () => {
    for (const m of [
      "The studio is busy right now. Please try again in a minute.",
      "Could not access your camera. Check camera permissions and try again.",
      "Go live is available on paid plans. Switch it off under Go live to use your free trial.",
      "Elite AI background needs a Professional or Enterprise key",
    ]) expect(brandMessage(m, FALLBACK)).toBe(m);
  });

  it("falls back on empty input", () => {
    expect(brandMessage(undefined, FALLBACK)).toBe(FALLBACK);
    expect(brandMessage("   ", FALLBACK)).toBe(FALLBACK);
  });

  it("doesn't flag ordinary words that merely contain the letters", () => {
    expect(mentionsProvider("Upload a clear photo of an individual")).toBe(false);
    expect(mentionsProvider("smart camera framing")).toBe(false);
  });
});
