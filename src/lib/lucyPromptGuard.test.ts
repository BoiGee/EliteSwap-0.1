import { describe, expect, test } from "vitest";
import { sanitizePromptForLucy, buildPromptWithIdentityGuard } from "./lucyPromptGuard";

const MAX_LUCY_PROMPT_LENGTH = 2200;

describe("sanitizePromptForLucy", () => {
  describe("empty prompt handling", () => {
    test("returns default message when prompt is undefined", () => {
      expect(sanitizePromptForLucy(undefined)).toBe("Enhance the video slightly");
    });

    test("returns default message when prompt is empty string", () => {
      expect(sanitizePromptForLucy("")).toBe("Enhance the video slightly");
    });

    test("returns default message for whitespace-only input", () => {
      expect(sanitizePromptForLucy("   ")).toBe("Enhance the video slightly");
    });
  });

  describe("normalization and length capping", () => {
    test("preserves prompt unchanged when within limit", () => {
      const short = "a".repeat(2190);
      expect(sanitizePromptForLucy(short)).toBe(short);
    });

    test("truncates with ellipsis when over limit", () => {
      const long = "x".repeat(MAX_LUCY_PROMPT_LENGTH + 5);
      const result = sanitizePromptForLucy(long);
    expect(result.length).toBeLessThanOrEqual(MAX_LUCY_PROMPT_LENGTH);
      expect(result.endsWith("...")).toBe(true);
  });

    test("handles multiple spaces by normalizing to single space", () => {
      const input = "hello   world";
      expect(sanitizePromptForLucy(input)).toBe("hello world");
  });

    test("trims leading/trailing whitespace during normalization", () => {
      const input = "  hello world  ";
      const result = sanitizePromptForLucy(input);
      expect(result).toBe("hello world");
  });

    test("handles prompt exactly at limit without truncation", () => {
      const exact = "x".repeat(MAX_LUCY_PROMPT_LENGTH);
      expect(sanitizePromptForLucy(exact).length).toBe(MAX_LUCY_PROMPT_LENGTH);
  });
  });
});

describe("buildPromptWithIdentityGuard", () => {
  describe("identity guard suffix injection", () => {
    test("appends identity and negative prompt suffixes when not present", () => {
      const input = "Make the video look better";
      const result = buildPromptWithIdentityGuard(input);
      expect(result).toContain(", preserve reference face identity");
      expect(result).toContain(", avoid extra limbs");
  });

    test("does not duplicate identity guard when already present", () => {
      const input = "Make the video look better, preserve reference face identity";
      const result = buildPromptWithIdentityGuard(input);
      const count = (result.match(/preserve reference face identity/g) || []).length;
      expect(count).toBe(1);
  });

    test("handles empty prompt after sanitization", () => {
      const input = "";
      const result = buildPromptWithIdentityGuard(input);
      expect(result).toContain("Enhance the video slightly");
      expect(result).toContain(", preserve reference face identity");
});

    test("preserves existing negative prompt keywords without duplication", () => {
      const input = "Make it look good, avoid extra limbs";
      const result = buildPromptWithIdentityGuard(input);
      const count = (result.match(/avoid extra limbs/g) || []).length;
      expect(count).toBe(1);
    });

    test("handles prompt with multiple spaces", () => {
      const input = "  Make   it   look   good";
      const result = buildPromptWithIdentityGuard(input);
      expect(result).toContain(", preserve reference face identity");
    });
  });

  describe("edge cases and length constraints", () => {
    test("handles prompt exactly at MAX_LUCY_PROMPT_LENGTH", () => {
      const exact = "x".repeat(2200);
      const result = buildPromptWithIdentityGuard(exact);
      expect(result.length).toBeLessThanOrEqual(MAX_LUCY_PROMPT_LENGTH + 600); // identity + negative suffix combined is ~572 chars
    });

    test("handles prompt over MAX_LUCY_PROMPT_LENGTH", () => {
      const long = "x".repeat(2300);
      const result = buildPromptWithIdentityGuard(long);
      expect(result.length).toBeLessThanOrEqual(MAX_LUCY_PROMPT_LENGTH + 600); // identity + negative suffix combined is ~572 chars
    });

    test("handles prompt with trailing whitespace", () => {
      const input = "Make it look good   ";
      const result = buildPromptWithIdentityGuard(input);
      expect(result).toContain(", preserve reference face identity");
    });

    test("handles prompt with leading whitespace", () => {
      const input = "   Make it look good";
      const result = buildPromptWithIdentityGuard(input);
      expect(result.startsWith("Make it look good, preserve reference face identity")).toBe(true);
    });
  });
});

