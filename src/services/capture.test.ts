import { describe, expect, it } from "vitest";
import i18next from "i18next";
import en from "../locales/en.json";
import ru from "../locales/ru.json";
import { CaptureStatus } from "../types";

// The app's i18n module touches the document; tests use the same catalogs directly.
const i18n = i18next.createInstance();
await i18n.init({ resources: { en: { translation: en }, ru: { translation: ru } }, lng: "en", interpolation: { escapeValue: false } });
import { appIsOlder, captureReport, connectedNames, lastSaved, preferredBrowser, statusColor, statusLabel } from "./capture";

const base: CaptureStatus = {
  state: "none",
  browsers: [],
  last_capture: null,
  days_silent: null,
  problem: null,
  detail: null,
  protocol: 2,
};
const seen = (browser: "chrome" | "edge" | "firefox", recent = true, protocol = 2) => ({
  browser,
  last_seen: "2026-10-03T09:00:00.000Z",
  extension_version: "0.5.0",
  extension_protocol: protocol,
  compatible: protocol === 2,
  recent,
});

describe("browser status", () => {
  it("labels every state in the sidebar", async () => {
    await i18n.changeLanguage("ru");
    const t = i18n.t.bind(i18n);
    expect(statusLabel(null, t)).toBe("Проверяем захват…");
    expect(statusLabel(base, t)).toBe("Браузер не подключён");
    expect(statusLabel({ ...base, state: "connected", browsers: [seen("chrome")] }, t)).toBe("Браузер подключён");
    expect(statusLabel({ ...base, state: "lost", days_silent: 3 }, t)).toBe("Нет связи 3 дня");
    expect(statusLabel({ ...base, state: "lost", days_silent: 5 }, t)).toBe("Нет связи 5 дней");
    expect(statusLabel({ ...base, state: "failing", problem: "channel" }, t)).toBe("Захват не работает");
    const old = { ...base, state: "incompatible" as const, browsers: [seen("firefox", true, 1)] };
    expect(statusLabel(old, t)).toBe("Обновите расширение");
    expect(appIsOlder(old)).toBe(false);
    const newer = { ...old, browsers: [seen("firefox", true, 3)] };
    expect(statusLabel(newer, t)).toBe("Обновите Netami Pin");
    expect(statusColor(newer)).toBe("var(--np-ochre)");
    expect(statusColor(null)).toBe("var(--np-faint)");
  });

  it("names only browsers that wrote recently with the right protocol", () => {
    const status = { ...base, browsers: [seen("chrome"), seen("edge", false), seen("firefox", true, 1)] };
    expect(connectedNames(status)).toBe("Chrome");
    expect(preferredBrowser(status)).toBe("chrome");
    expect(preferredBrowser({ ...status, last_capture: { at: "2026-10-03T09:00:00.000Z", browser: "firefox" } })).toBe("firefox");
    expect(preferredBrowser(null)).toBe("chrome");
  });

  it("says when and where the last page was saved", async () => {
    await i18n.changeLanguage("en");
    const t = i18n.t.bind(i18n);
    expect(lastSaved(base, t, "en")).toBe("No pages saved yet");
    const at = new Date(2026, 9, 3, 11, 48).toISOString();
    const status = { ...base, last_capture: { at, browser: "edge" as const } };
    expect(lastSaved(status, t, "en", new Date(2026, 9, 3, 18, 0))).toMatch(/^Last saved today at 11:48 (AM )?from Edge$/);
    expect(lastSaved(status, t, "en", new Date(2026, 9, 5, 9, 0))).toMatch(/^Last saved October 3 at 11:48 (AM )?from Edge$/);
  });

  it("puts the problem and every browser into the report", () => {
    const report = captureReport({ ...base, state: "failing", problem: "channel", detail: "Access is denied.", browsers: [seen("chrome")] }, "0.1.0");
    expect(report).toContain("Capture: failing (channel)");
    expect(report).toContain("Detail: Access is denied.");
    expect(report).toContain("Chrome: extension 0.5.0, protocol 2");
  });
});
