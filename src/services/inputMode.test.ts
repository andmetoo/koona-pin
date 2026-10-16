import { describe, expect, it } from "vitest";
import { inputModeOf } from "./inputMode";

describe("inputModeOf", () => {
  it("keys that move focus show it", () => {
    for (const key of ["Tab", "ArrowDown", "ArrowRight", "Home", "End", "PageDown"]) expect(inputModeOf(key)).toBe("keys");
  });
  it("Esc, Space, letters and modifiers do not", () => {
    for (const key of ["Escape", " ", "Enter", "f", "r", "Delete", "Shift", "Meta"]) expect(inputModeOf(key)).toBeNull();
  });
});
