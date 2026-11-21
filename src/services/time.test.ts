import { describe, expect, it } from "vitest";
import { dayStarts, groupOf, groupSizes, untilMidnight } from "./dateGroups";
import { RECENT_DAYS, recentTime, relativeTime } from "./relativeTime";

describe("date groups", () => {
  const now = new Date(2026, 9, 3, 15, 30);
  const starts = dayStarts(now);
  const at = (day: number, hour: number) => new Date(2026, 9, day, hour).toISOString();

  it("starts at local midnights in the stored format", () => {
    expect(starts).toEqual([at(3, 0), at(2, 0), new Date(2026, 8, 27).toISOString()]);
    expect(starts[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
  it("puts a bookmark into its group by local day", () => {
    expect(groupOf(at(3, 0), starts)).toBe("today");
    expect(groupOf(at(2, 23), starts)).toBe("yesterday");
    expect(groupOf(new Date(2026, 8, 27, 9).toISOString(), starts)).toBe("week");
    expect(groupOf(new Date(2026, 8, 26, 23).toISOString(), starts)).toBe("earlier");
  });
  it("turns counts since each start into group sizes", () => {
    expect(groupSizes(128, [3, 6, 20])).toEqual({ today: 3, yesterday: 3, week: 14, earlier: 108 });
    expect(groupSizes(5, [])).toEqual({ today: 0, yesterday: 0, week: 0, earlier: 5 });
  });
  it("knows when the groups move", () => {
    expect(untilMidnight(now)).toBe((8 * 60 + 30) * 60 * 1000);
  });
});

const relativeNow = Date.parse("2026-10-16T12:00:00.000Z");
const ago = (seconds: number) => new Date(relativeNow - seconds * 1000).toISOString();

describe("relativeTime", () => {
  it("says now, minutes, hours and days in the interface's language", () => {
    expect(relativeTime(ago(20), "en", relativeNow)).toBe("now");
    expect(relativeTime(ago(5 * 60), "en", relativeNow)).toBe("5 min. ago");
    expect(relativeTime(ago(3 * 3600), "en", relativeNow)).toBe("3 hr. ago");
    expect(relativeTime(ago(86400), "en", relativeNow)).toBe("yesterday");
    expect(relativeTime(ago(3 * 86400), "en", relativeNow)).toBe("3 days ago");
    expect(relativeTime(ago(3 * 86400), "ru", relativeNow)).toBe(new Intl.RelativeTimeFormat("ru", { numeric: "auto", style: "short" }).format(-3, "day"));
  });
  it("gives nothing for a bad date and «now» for one a little ahead", () => {
    expect(relativeTime("not a date", "en", relativeNow)).toBeNull();
    expect(relativeTime(ago(-30), "en", relativeNow)).toBe("now");
  });
});

describe("recentTime", () => {
  it("shows a time within the last week", () => {
    expect(recentTime(ago(2 * 3600), "en", relativeNow)).toBe("2 hr. ago");
    expect(recentTime(ago(RECENT_DAYS * 86400), "en", relativeNow)).toBe("7 days ago");
  });
  it("omits an older one, such as an imported bookmark's browser date", () => {
    expect(recentTime(ago(RECENT_DAYS * 86400 + 60), "en", relativeNow)).toBeNull();
    expect(recentTime("2019-10-16T12:00:00.000Z", "en", relativeNow)).toBeNull();
    expect(recentTime("not a date", "en", relativeNow)).toBeNull();
  });
});
