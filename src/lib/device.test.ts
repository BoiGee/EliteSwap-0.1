import { describe, expect, it } from "vitest";
import { inAppBrowser, isPhone } from "./device";

const UA = {
  iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  androidChrome: "Mozilla/5.0 (Linux; Android 14; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  androidTablet: "Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  windowsChrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  instagram: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 345.0.0.32.97",
  facebookAndroid: "Mozilla/5.0 (Linux; Android 14; Infinix X6833B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/485.0.0.0;]",
  tiktok: "Mozilla/5.0 (Linux; Android 13; TECNO KI5q; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.0.0 Mobile Safari/537.36 trill_370504 BytedanceWebview/d8a21c6",
  androidWebView: "Mozilla/5.0 (Linux; Android 12; itel A665L; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.0.0 Mobile Safari/537.36",
};

describe("isPhone", () => {
  it("detects phones and leaves tablets and computers out", () => {
    expect(isPhone({ userAgent: UA.iphoneSafari })).toBe(true);
    expect(isPhone({ userAgent: UA.androidChrome })).toBe(true);
    expect(isPhone({ userAgent: UA.androidTablet })).toBe(false);
    expect(isPhone({ userAgent: UA.windowsChrome })).toBe(false);
  });
  it("prefers the browser's own mobile hint when present", () => {
    expect(isPhone({ userAgent: UA.windowsChrome, userAgentData: { mobile: true } })).toBe(true);
    expect(isPhone({ userAgent: UA.androidChrome, userAgentData: { mobile: false } })).toBe(false);
  });
});

describe("inAppBrowser", () => {
  it("names the app whose built-in browser is in use", () => {
    expect(inAppBrowser({ userAgent: UA.instagram })).toBe("Instagram");
    expect(inAppBrowser({ userAgent: UA.facebookAndroid })).toBe("Facebook");
    expect(inAppBrowser({ userAgent: UA.tiktok })).toBe("TikTok");
    expect(inAppBrowser({ userAgent: UA.androidWebView })).toBe("an app");
  });
  it("leaves real browsers alone", () => {
    expect(inAppBrowser({ userAgent: UA.iphoneSafari })).toBeNull();
    expect(inAppBrowser({ userAgent: UA.androidChrome })).toBeNull();
    expect(inAppBrowser({ userAgent: UA.windowsChrome })).toBeNull();
  });
});
