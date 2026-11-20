import { describe, expect, it } from "vitest";
import { callAppsFor, callSteps } from "./callGuide";

describe("call guide", () => {
  it("offers FaceTime on iPhone only", () => {
    expect(callAppsFor(true)).toContain("facetime");
    expect(callAppsFor(false)).not.toContain("facetime");
    expect(callAppsFor(false)).toEqual(["whatsapp", "telegram", "zoom", "meet", "messenger"]);
  });

  it("starts the call and the sharing before connecting the studio", () => {
    const steps = callSteps("whatsapp", true);
    const call = steps.findIndex((s) => s.includes("start a video call"));
    const share = steps.findIndex((s) => s.includes("Share screen"));
    const connect = steps.findIndex((s) => s.includes("tap Connect"));
    expect(call).toBeGreaterThan(-1);
    expect(share).toBeGreaterThan(call);
    expect(connect).toBeGreaterThan(share);
  });

  it("uses each platform's own confirmation button", () => {
    expect(callSteps("zoom", true).join(" ")).toContain("Start Broadcast");
    expect(callSteps("zoom", false).join(" ")).toContain("Start now");
    expect(callSteps("telegram", false).join(" ")).toContain("Telegram");
  });
});
