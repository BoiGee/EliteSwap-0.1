import { describe, expect, it } from "vitest";
import { generateClientId } from "@/lib/utils";

describe("generateClientId", () => {
  it("falls back when crypto.randomUUID is unavailable", () => {
    const originalRandomUUID = globalThis.crypto.randomUUID;
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: undefined,
      configurable: true,
    });

    try {
      const id = generateClientId();
      expect(id).toMatch(/^id-/);
    } finally {
      Object.defineProperty(globalThis.crypto, "randomUUID", {
        value: originalRandomUUID,
        configurable: true,
      });
    }
  });

  it("generates a valid UUID when crypto.randomUUID is available", () => {
    const id = generateClientId();
    expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
  });

  it("handles empty string input", () => {
    const id = generateClientId("");
    expect(id).toBeDefined();
  });

  it("handles whitespace-only strings", () => {
    const id = generateClientId("   ");
    expect(id).toBeDefined();
  });

  it("handles very long strings", () => {
    const longString = "a".repeat(1000);
    const id = generateClientId(longString);
    expect(id).toBeDefined();
  });
});

