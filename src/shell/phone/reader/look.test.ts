import { describe, expect, it } from "vitest";
import { type ReaderChoice, resolveReaderLook, SIZES } from "../../../services/readerLook";
import { phoneReaderLook, stepSize } from "./look";

const choice = (more: Partial<ReaderChoice> = {}): ReaderChoice => ({ theme: "auto", font: "serif", size: 18, column: "medium", ...more });
const lookOf = (c: ReaderChoice, appDark = false) => phoneReaderLook(resolveReaderLook(c, { appDark, unlocked: false }), c);

describe("the phone's reading look", () => {
  it("reads R1's Literata 19/30 at the default size", () => {
    const { style, page } = lookOf(choice());
    expect(style["--rd-size"]).toBe("19px");
    expect(style["--rd-line"]).toBe("30px");
    expect(style["--rd-font"]).toContain("Literata");
    expect(page).toBeNull();
  });

  it("keeps the phone's own paper and mesh while it matches the app", () => {
    const { style } = lookOf(choice(), true);
    expect(style["--ph-bg"]).toBeUndefined();
    expect(style["--ph-mesh"]).toBeUndefined();
  });

  it("paints a chosen theme through the phone's tokens, with the glass of its tone", () => {
    const dark = lookOf(choice({ theme: "dark" }));
    expect(dark.page).toBe("dark");
    expect(dark.style["--ph-bg"]).toBe("#1e1d1a");
    expect(dark.style["--ph-accent"]).toBe("#8fd0ae");
    const white = lookOf(choice({ theme: "white" }), true);
    expect(white.page).toBe("light");
    expect(white.style["--ph-bg"]).toBe("#ffffff");
    expect(white.style.colorScheme).toBe("light");
  });

  it("takes the font and size of the choice", () => {
    const { style } = lookOf(choice({ font: "sans", size: 22 }));
    expect(style["--rd-font"]).toBe("var(--np-font)");
    expect(style["--rd-size"]).toBe("23px");
    expect(style["--rd-line"]).toBe("36px");
  });

  it("steps the size within the slider's sizes", () => {
    expect(stepSize(18, 1)).toBe(19);
    expect(stepSize(18, -1)).toBe(17);
    expect(stepSize(SIZES[0], -1)).toBe(SIZES[0]);
    expect(stepSize(SIZES[SIZES.length - 1], 1)).toBe(SIZES[SIZES.length - 1]);
    expect(stepSize(13, 1)).toBe(19);
  });
});
