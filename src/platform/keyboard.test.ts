import { describe, expect, it } from "vitest";
import { keyboardUp } from "./keyboard";

describe("the on-screen keyboard", () => {
  it("is up when Android's bottom inset is taller than any system bar", () => {
    expect(keyboardUp(24, 852, 852)).toBe(false);
    expect(keyboardUp(48, 852, 852)).toBe(false);
    expect(keyboardUp(336, 852, 852)).toBe(true);
  });

  it("is up when the visual viewport shrinks (iOS, a browser)", () => {
    expect(keyboardUp(34, 852, 516)).toBe(true);
    expect(keyboardUp(34, 852, 800)).toBe(false);
    expect(keyboardUp(0, 852, null)).toBe(false);
  });
});
