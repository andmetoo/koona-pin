import { describe, it, expect } from "vitest";
import { browsers, localBrowsers, manifest, safariMinVersion } from "../../scripts/build-extension.mjs";
import { VERSION } from "./version.js";

describe("manifests", () => {
  it("ships Chrome, Edge and Firefox; Safari is a local build only (NP-119)", () => {
    expect(browsers).toEqual(["chrome", "edge", "firefox"]);
    expect(localBrowsers).toEqual(["safari"]);
  });

  it("gives Safari a non-persistent background page and nothing of the others' (NP-119)", () => {
    const safari = manifest("safari", { dev: true, key: "a key" });
    expect(safari.version).toBe(VERSION);
    expect(safari.manifest_version).toBe(3);
    expect(safari.background).toEqual({ scripts: ["worker.js"], type: "module", persistent: false });
    expect(safari.permissions).toEqual(["activeTab", "scripting", "storage", "alarms", "nativeMessaging", "menus"]);
    expect(safari.optional_permissions).toEqual(["tabs"]);
    expect(safari.commands["quick-search"].suggested_key).toEqual({ default: "Alt+Shift+D" });
    expect(safari.options_ui).toEqual({ page: "options.html", open_in_tab: true });
    expect(safari.default_locale).toBe("en");
    expect(safari.browser_specific_settings).toEqual({ safari: { strict_min_version: safariMinVersion } });
    for (const key of ["key", "minimum_chrome_version"]) expect(safari, key).not.toHaveProperty(key);
  });

  it("keeps the Chromium and Firefox manifests", () => {
    expect(manifest("chrome", { dev: true, key: "k" })).toMatchObject({ key: "k", minimum_chrome_version: "120" });
    expect(manifest("chrome")).not.toHaveProperty("key");
    expect(manifest("edge").background).toEqual({ service_worker: "worker.js", type: "module" });
    expect(manifest("firefox").background).toEqual({ scripts: ["worker.js"], type: "module" });
    expect(manifest("firefox").browser_specific_settings).toHaveProperty("gecko");
  });

  it("gives every browser the Save to Reading shortcut, apart from the search's (NP-125)", () => {
    for (const browser of [...browsers, ...localBrowsers]) {
      const { commands } = manifest(browser);
      expect(commands["save-to-reading"], browser).toEqual({
        suggested_key: { default: "Alt+Shift+R" },
        description: "__MSG_commandReading__",
      });
      const keys = Object.values(commands).map((command) => command.suggested_key.default);
      expect(new Set(keys).size, browser).toBe(keys.length);
      // Chrome takes at most four suggested shortcuts.
      expect(keys.length, browser).toBeLessThanOrEqual(4);
    }
  });
});
