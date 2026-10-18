import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import { savedLine } from "./savedLine";

// The keys with their values, as the English strings put them together.
const t = ((key: string, values: Record<string, string>) =>
  ({
    "phone.detail.savedToday": `Saved today, ${values.time}`,
    "phone.detail.savedYesterday": `Saved yesterday, ${values.time}`,
    "phone.detail.savedOn": `Saved ${values.date}`,
  })[key] ?? key) as unknown as TFunction;

describe("FL1's saved line", () => {
  const now = new Date(2026, 9, 18, 15, 0).getTime();
  it("says today and yesterday with the time", () => {
    expect(savedLine(new Date(2026, 9, 18, 9, 12).toISOString(), t, "en-GB", now)).toBe("Saved today, 9:12");
    expect(savedLine(new Date(2026, 9, 17, 23, 5).toISOString(), t, "en-GB", now)).toBe("Saved yesterday, 23:05");
  });
  it("says the date further back, with the year only when it is not this one", () => {
    expect(savedLine(new Date(2026, 2, 12, 8).toISOString(), t, "en-GB", now)).toBe("Saved 12 Mar");
    expect(savedLine(new Date(2025, 2, 12, 8).toISOString(), t, "en-GB", now)).toBe("Saved 12 Mar 2025");
  });
  it("says nothing for a bad date", () => {
    expect(savedLine("not a date", t, "en-GB", now)).toBe("");
  });
});
