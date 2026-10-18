import { describe, expect, it } from "vitest";
import { goBack, isMobile, onBack, platform } from "./platform";

describe("platform", () => {
  it("is the desktop without the phone bridge", () => {
    expect(platform).toBe("desktop");
    expect(isMobile).toBe(false);
  });

  it("goes back one level, newest first, and says when there was nothing to close", () => {
    const closed: string[] = [];
    const offEditor = onBack(() => (closed.push("editor"), true));
    const offIdle = onBack(() => false);
    const offDialog = onBack(() => (closed.push("dialog"), true));
    expect(goBack()).toBe(true);
    expect(closed).toEqual(["dialog"]);
    offDialog();
    // A handler with nothing open passes Back on.
    expect(goBack()).toBe(true);
    expect(closed).toEqual(["dialog", "editor"]);
    offEditor();
    offIdle();
    expect(goBack()).toBe(false);
  });
});
