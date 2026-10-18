import { afterEach, describe, expect, it, vi } from "vitest";
import { capabilities, desktopCommands } from "./capabilities";
import { isMobile, platform } from "./platform";

describe("platform", () => {
  it("is a desktop that can do what a desktop does without the app's info (the demo, the tests)", () => {
    expect(platform).toBe("desktop");
    expect(isMobile).toBe(false);
    expect(capabilities).toMatchObject({ file_manager: true, tray: true, quit: true, browser_capture: true, mcp: true, updates: "self" });
    expect(desktopCommands).toBe(true);
  });

  describe("on a phone", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.resetModules();
    });

    it("is read from the app's info, with its capabilities and without the desktop's commands", async () => {
      vi.resetModules();
      const phone = { file_manager: false, tray: false, quit: false, updates: "store" };
      vi.stubGlobal("window", { __KOONA__: { platform: "ios", capabilities: phone } });
      const { platform, isMobile } = await import("./platform");
      const { capabilities, desktopCommands } = await import("./capabilities");
      expect([platform, isMobile]).toEqual(["ios", true]);
      expect(capabilities).toEqual(phone);
      expect(desktopCommands).toBe(false);
    });
  });
});
