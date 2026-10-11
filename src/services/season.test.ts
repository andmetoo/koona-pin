import { describe, expect, it } from "vitest";
import { seasonOf } from "./season";

describe("seasonOf", () => {
  it("follows the northern calendar by months", () => {
    const at = (month: number) => seasonOf(new Date(2026, month, 15));
    expect([0, 1, 11].map(at)).toEqual(["winter", "winter", "winter"]);
    expect([2, 3, 4].map(at)).toEqual(["spring", "spring", "spring"]);
    expect([5, 6, 7].map(at)).toEqual(["summer", "summer", "summer"]);
    expect([8, 9, 10].map(at)).toEqual(["autumn", "autumn", "autumn"]);
  });
});
