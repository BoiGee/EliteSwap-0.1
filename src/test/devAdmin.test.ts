import { beforeEach, describe, expect, it } from "vitest";
import { isDevAdminOverrideEnabled, setDevAdminOverride, clearDevAdminOverride } from "@/lib/devAdmin";

describe("dev admin override", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("enables admin access from the query string in dev mode", () => {
    expect(isDevAdminOverrideEnabled("?devAdmin=1", window.localStorage, true)).toBe(true);
  });

  it("enables admin access from local storage in dev mode", () => {
    setDevAdminOverride(true, window.localStorage);
    expect(isDevAdminOverrideEnabled("", window.localStorage, true)).toBe(true);
  });

  it("clears the override when requested", () => {
    setDevAdminOverride(true, window.localStorage);
    clearDevAdminOverride(window.localStorage);
    expect(isDevAdminOverrideEnabled("", window.localStorage, true)).toBe(false);
  });
});
