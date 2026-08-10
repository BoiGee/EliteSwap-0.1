import { describe, expect, it } from "vitest";
import { buildPromptWithIdentityGuard, sanitizePromptForLucy } from "@/lib/lucyPromptGuard";

describe("StudioTermsGate", () => {
  it("falls back to a safe default when the prompt is empty", () => {
    expect(sanitizePromptForLucy("   ")).toBe("Enhance the video slightly");
  });

  it("trims and appends the identity guard only once", () => {
    const prompt = "  Make the face look sharper  ";
    const result = buildPromptWithIdentityGuard(prompt);
    expect(result).toContain("Make the face look sharper");
    expect(result).toContain("preserve reference face identity");
    expect(result.match(/preserve reference face identity/g)).toHaveLength(1);
  });

  it("caps very long prompts before sending them to Lucy", () => {
    const longPrompt = "x".repeat(5000);
    const result = sanitizePromptForLucy(longPrompt);
    expect(result.length).toBeLessThanOrEqual(2200);
  });

  it("does not duplicate identity guard when already present in prompt", () => {
    const prompt = "Make the face look sharper, preserve reference face identity";
    const result = buildPromptWithIdentityGuard(prompt);
    expect(result.match(/preserve reference face identity/g)).toHaveLength(1);
  });

  it("includes negative prompt suffix when not already present", () => {
    const prompt = "Enhance the video slightly";
    const result = buildPromptWithIdentityGuard(prompt);
    expect(result).toContain("avoid extra limbs");
    expect(result).toContain("avoid nudity");
  });

  it("does not duplicate negative suffix when already present", () => {
    const prompt = "Make the face look sharper, avoid extra limbs";
    const result = buildPromptWithIdentityGuard(prompt);
    expect(result.match(/avoid extra limbs/g)).toHaveLength(1);
  });

  it("handles prompts exactly at the length cap boundary", () => {
    const exactCap = "x".repeat(MAX_LUCY_PROMPT_LENGTH);
    const result = sanitizePromptForLucy(exactCap);
    expect(result.length).toBeLessThanOrEqual(MAX_LUCY_PROMPT_LENGTH);
  });

  it("handles prompts just over the length cap boundary", () => {
    const overCap = "x".repeat(MAX_LUCY_PROMPT_LENGTH + 10);
    const result = sanitizePromptForLucy(overCap);
    expect(result.length).toBeLessThanOrEqual(MAX_LUCY_PROMPT_LENGTH);
  });

  it("handles prompts with multiple whitespace sequences", () => {
    const prompt = "a   b\t\nc\n\nd";
    const result = sanitizePromptForLucy(prompt);
    expect(result).toBe("a b c d");
  });

  it("handles single-character prompts", () => {
    const result = sanitizePromptForLucy("x");
    expect(result.length).toBeGreaterThan(0);
  });

  it("handles unicode and emoji characters", () => {
    const prompt = "Make the face look sharper, 🎨✨";
    const result = buildPromptWithIdentityGuard(prompt);
    expect(result).toContain("🎨");
    expect(result).toContain("✨");
  });

  it("handles prompts with trailing newlines and tabs", () => {
    const prompt = "Make the face look sharper\n\t";
    const result = sanitizePromptForLucy(prompt);
    expect(result).toBe("Make the face look sharper");
  });
});