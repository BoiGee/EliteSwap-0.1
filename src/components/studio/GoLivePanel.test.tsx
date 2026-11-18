import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { GoLivePanel } from "./GoLivePanel";
import type { GoLiveSettings } from "@/lib/goLive";

const off: GoLiveSettings = { enabled: false, platform: "youtube", server: "rtmp://a.rtmp.youtube.com/live2", streamKey: "" };

describe("GoLivePanel", () => {
  it("shows only the switch and blurb while off", () => {
    render(<GoLivePanel settings={off} onChange={() => {}} relaying={null} backgroundOn={false} />);
    expect(screen.getByText(/Stream your swap straight to YouTube/)).toBeTruthy();
    expect(screen.queryByLabelText("Stream key")).toBeNull();
  });

  it("shows the fields, hides the key, and flags a missing key when on", () => {
    render(<GoLivePanel settings={{ ...off, enabled: true }} onChange={() => {}} relaying={null} backgroundOn={false} />);
    expect((screen.getByLabelText("Server URL") as HTMLInputElement).value).toBe("rtmp://a.rtmp.youtube.com/live2");
    expect((screen.getByLabelText("Stream key") as HTMLInputElement).type).toBe("password");
    expect(screen.getByText("Add your stream key.")).toBeTruthy();
  });

  it("picks Twitch's default ingest and reports the live state", () => {
    const onChange = vi.fn();
    render(<GoLivePanel settings={{ ...off, enabled: true, streamKey: "live_123" }} onChange={onChange} relaying backgroundOn />);
    fireEvent.click(screen.getByText("Twitch"));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ platform: "twitch", server: "rtmp://ingest.global-contribute.live-video.net/app" }));
    expect(screen.getByText(/Streaming to YouTube/)).toBeTruthy();
    expect(screen.getByText(/without the Elite AI background/)).toBeTruthy();
  });
});
