import { describe, expect, it } from "vitest";
import { RECENT_DAYS, recentTime, relativeTime } from "./relativeTime";

const now = Date.parse("2026-10-16T12:00:00.000Z");
const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

describe("relativeTime", () => {
  it("says now, minutes, hours and days in the interface's language", () => {
    expect(relativeTime(ago(20), "en", now)).toBe("now");
    expect(relativeTime(ago(5 * 60), "en", now)).toBe("5 min. ago");
    expect(relativeTime(ago(3 * 3600), "en", now)).toBe("3 hr. ago");
    expect(relativeTime(ago(86400), "en", now)).toBe("yesterday");
    expect(relativeTime(ago(3 * 86400), "en", now)).toBe("3 days ago");
    expect(relativeTime(ago(3 * 86400), "ru", now)).toBe(new Intl.RelativeTimeFormat("ru", { numeric: "auto", style: "short" }).format(-3, "day"));
  });
  it("gives nothing for a bad date and «now» for one a little ahead", () => {
    expect(relativeTime("not a date", "en", now)).toBeNull();
    expect(relativeTime(ago(-30), "en", now)).toBe("now");
  });
});

describe("recentTime", () => {
  it("shows a time within the last week", () => {
    expect(recentTime(ago(2 * 3600), "en", now)).toBe("2 hr. ago");
    expect(recentTime(ago(RECENT_DAYS * 86400), "en", now)).toBe("7 days ago");
  });
  it("omits an older one, such as an imported bookmark's browser date", () => {
    expect(recentTime(ago(RECENT_DAYS * 86400 + 60), "en", now)).toBeNull();
    expect(recentTime("2019-10-16T12:00:00.000Z", "en", now)).toBeNull();
    expect(recentTime("not a date", "en", now)).toBeNull();
  });
});
