import { describe, expect, it } from "vitest";
import { dayStarts, groupOf, groupSizes, untilMidnight } from "./dateGroups";

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
