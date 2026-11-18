import { describe, expect, it } from "vitest";
import { goLiveProblem, goLiveRtmpUrl, type GoLiveSettings } from "./goLive";

const base: GoLiveSettings = { enabled: true, platform: "youtube", server: "rtmp://a.rtmp.youtube.com/live2", streamKey: "abcd-efgh-ijkl-mnop" };

describe("goLiveRtmpUrl", () => {
  it("joins server and key with one slash", () => {
    expect(goLiveRtmpUrl(base)).toBe("rtmp://a.rtmp.youtube.com/live2/abcd-efgh-ijkl-mnop");
    expect(goLiveRtmpUrl({ ...base, server: "rtmp://a.rtmp.youtube.com/live2/", streamKey: " /abcd " })).toBe("rtmp://a.rtmp.youtube.com/live2/abcd");
  });
  it("keeps query strings in TikTok-style keys", () => {
    const s = { ...base, platform: "tiktok" as const, server: "rtmp://push-rtmp.example.com/game/", streamKey: "stream-123?expire=1&sign=x" };
    expect(goLiveRtmpUrl(s)).toBe("rtmp://push-rtmp.example.com/game/stream-123?expire=1&sign=x");
  });
});

describe("goLiveProblem", () => {
  it("accepts a complete rtmp destination", () => {
    expect(goLiveProblem(base)).toBeNull();
    expect(goLiveProblem({ ...base, platform: "twitch", server: "rtmp://ingest.global-contribute.live-video.net/app" })).toBeNull();
  });
  it("rejects RTMPS, which Vidu's relay can't push to", () => {
    expect(goLiveProblem({ ...base, server: "rtmps://live-api-s.facebook.com:443/rtmp/" })).toMatch(/RTMPS/);
  });
  it("rejects a missing or malformed server, and a missing or spaced key", () => {
    expect(goLiveProblem({ ...base, server: "" })).toMatch(/server URL/);
    expect(goLiveProblem({ ...base, server: "https://youtube.com" })).toMatch(/rtmp:\/\//);
    expect(goLiveProblem({ ...base, server: "rtmp://host-only" })).toMatch(/rtmp:\/\//);
    expect(goLiveProblem({ ...base, streamKey: "  " })).toMatch(/stream key/);
    expect(goLiveProblem({ ...base, streamKey: "ab cd" })).toMatch(/spaces/);
  });
});
