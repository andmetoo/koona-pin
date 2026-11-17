import { describe, expect, it } from "vitest";
import { codeOf, visibleName } from "./tagCleanup";

/** The name as one line: `co[U+00AD]op`. */
const plainName = (name: string) => visibleName(name).map((part) => ("text" in part ? part.text : `[${part.code}]`)).join("");

describe("visibleName", () => {
  it("shows a soft hyphen and a zero-width space by their codes", () => {
    expect(visibleName("co\u{AD}op")).toEqual([{ text: "co" }, { code: "U+00AD" }, { text: "op" }]);
    expect(visibleName("\u{200B}")).toEqual([{ code: "U+200B" }]);
    expect(plainName("re\u{200B}ad\u{200B}")).toBe("re[U+200B]ad[U+200B]");
  });

  it("shows tag characters, bidi marks, controls and odd spaces, keeps the plain space", () => {
    expect(plainName("a\u{E0041}\u{E0042}")).toBe("a[U+E0041][U+E0042]");
    expect(plainName("x\u{202E}y")).toBe("x[U+202E]y");
    expect(plainName("a\tb")).toBe("a[U+0009]b");
    expect(plainName("to read\u{A0}later")).toBe("to read[U+00A0]later");
    expect(plainName("Coop")).toBe("Coop");
  });

  it("leaves the joiner and variation selector of an emoji alone, not other unseen characters", () => {
    const family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
    expect(visibleName(family)).toEqual([{ text: family }]);
    expect(visibleName("\u{2764}\u{FE0F}")).toEqual([{ text: "\u{2764}\u{FE0F}" }]);
    expect(plainName("a\u{200D}b")).toBe("a[U+200D]b");
    expect(plainName("\u{1F600}\u{E0041}")).toBe("\u{1F600}[U+E0041]");
  });

  it("writes codes with at least four digits", () => {
    expect(codeOf("\u{AD}")).toBe("U+00AD");
    expect(codeOf("\u{E007F}")).toBe("U+E007F");
  });
});
