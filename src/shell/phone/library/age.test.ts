import { describe, expect, test } from "vitest";
import { shortAge } from "./age";

// Local times: the day boundaries are the person's own midnights.
const now = new Date(2026, 9, 18, 14, 30).getTime();
const at = (...parts: [number, number, number, number?, number?]) => new Date(...(parts as [number, number, number, number, number])).toISOString();

describe("shortAge", () => {
  test("now, minutes and hours within today", () => {
    expect(shortAge(new Date(now - 20_000).toISOString(), "en", now)).toBe("now");
    expect(shortAge(new Date(now - 5 * 60_000).toISOString(), "en", now)).toBe("5m");
    expect(shortAge(at(2026, 9, 18, 12, 10), "en", now)).toBe("2h");
    expect(shortAge(at(2026, 9, 18, 0, 5), "en", now)).toBe("14h");
  });

  test("the calendar day before is yesterday, even an hour ago after midnight", () => {
    expect(shortAge(at(2026, 9, 17, 9, 0), "en", now)).toBe("yesterday");
    const early = new Date(2026, 9, 18, 0, 30).getTime();
    expect(shortAge(at(2026, 9, 17, 23, 0), "en", early)).toBe("yesterday");
  });

  test("days, then weeks, then the date", () => {
    expect(shortAge(at(2026, 9, 15, 10, 0), "en", now)).toBe("3d");
    expect(shortAge(at(2026, 9, 4, 10, 0), "en", now)).toBe("2w");
    expect(shortAge(at(2026, 2, 12, 10, 0), "en", now)).toBe("Mar 12");
    expect(shortAge(at(2025, 2, 12, 10, 0), "en", now)).toBe("Mar 12, 2025");
  });

  test("a time ahead of the clock is now; a bad date is nothing", () => {
    expect(shortAge(new Date(now + 60_000).toISOString(), "en", now)).toBe("now");
    expect(shortAge("not a date", "en", now)).toBe("");
  });
});
