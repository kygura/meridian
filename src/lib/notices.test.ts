import { describe, it, expect } from "vitest";
import { base64UrlToBytes, describeDeliveries, noticeAge, noticeHash, noticeKindLabel } from "./notices";
import { isOffline } from "./pwa";

const d = (channel: string, ok: boolean) => ({ channel, ok, at: "2026-11-10T00:00:00Z" });

describe("describeDeliveries", () => {
  it("says the alert is in the list when no channel is set up", () => {
    expect(describeDeliveries([])).toEqual({ message: "Test alert added to Alerts. No other channel is set up.", ok: true });
  });
  it("names what worked and what failed, with labels", () => {
    const labels = { push: "Push", ntfy: "ntfy" };
    expect(describeDeliveries([d("push", true), d("ntfy", true)], labels)).toEqual({ message: "Test alert sent: Push, ntfy.", ok: true });
    expect(describeDeliveries([d("push", true), d("ntfy", false)], labels)).toEqual({ message: "Test alert sent: Push. Failed: ntfy.", ok: false });
    expect(describeDeliveries([d("email", false)])).toEqual({ message: "Test alert failed: email. It is still in Alerts.", ok: false });
  });
});

describe("noticeAge", () => {
  const now = new Date("2026-11-10T12:00:00Z");
  it("reads in minutes, hours, days, then a date", () => {
    expect(noticeAge("2026-11-10T11:59:40Z", now)).toBe("Just now");
    expect(noticeAge("2026-11-10T11:15:00Z", now)).toBe("45 min ago");
    expect(noticeAge("2026-11-10T07:00:00Z", now)).toBe("5 h ago");
    expect(noticeAge("2026-11-07T12:00:00Z", now)).toBe("3 d ago");
    expect(noticeAge("2026-10-01T12:00:00Z", now)).toBe("1 Oct 2026");
    expect(noticeAge("nonsense", now)).toBe("");
  });
});

describe("notice links and labels", () => {
  it("turns an app link into its hash and leaves outside links alone", () => {
    expect(noticeHash("/#/plan/watches")).toBe("#/plan/watches");
    expect(noticeHash("#/trips")).toBe("#/trips");
    expect(noticeHash("https://example.com/#/x")).toBeNull();
    expect(noticeHash(undefined)).toBeNull();
  });
  it("labels kinds in plain words", () => {
    expect(noticeKindLabel("watch-alert")).toBe("Watch");
    expect(noticeKindLabel("book-by")).toBe("Book by");
  });
});

describe("base64UrlToBytes", () => {
  it("decodes url-safe base64 without padding", () => {
    expect([...base64UrlToBytes("-_8")]).toEqual([251, 255]);
    expect(base64UrlToBytes("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4")).toHaveLength(65);
  });
});

describe("isOffline", () => {
  it("is offline when the browser says so or the API can't be reached", () => {
    expect(isOffline({ browserOnline: true, apiReachable: true })).toBe(false);
    expect(isOffline({ browserOnline: false, apiReachable: true })).toBe(true);
    expect(isOffline({ browserOnline: true, apiReachable: false })).toBe(true);
  });
});
