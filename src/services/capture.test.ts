import { describe, expect, it } from "vitest";
import i18next from "i18next";
import en from "../locales/en.json";
import ru from "../locales/ru.json";
import { CaptureStatus } from "../types";

// The app's i18n module touches the document; tests use the same catalogs directly.
const i18n = i18next.createInstance();
await i18n.init({ resources: { en: { translation: en }, ru: { translation: ru } }, lng: "en", interpolation: { escapeValue: false } });
import {
  appIsOlder,
  captureReport,
  connectTabs,
  connectedNames,
  installSteps,
  problemBanner,
  problemText,
  lastSaved,
  preferredBrowser,
  statusColor,
  statusLabel,
  tabBrowser,
} from "./capture";

const base: CaptureStatus = {
  state: "none",
  browsers: [],
  last_capture: null,
  days_silent: null,
  problem: null,
  detail: null,
  protocol: 2,
  system: "windows",
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
    expect(statusLabel(base, t)).toBe("Браузера пока нет");
    expect(statusLabel({ ...base, state: "connected", browsers: [seen("chrome")] }, t)).toBe("Браузер подключён");
    expect(statusLabel({ ...base, state: "lost", days_silent: 3 }, t)).toBe("Нет связи 3 дня");
    expect(statusLabel({ ...base, state: "lost", days_silent: 5 }, t)).toBe("Нет связи 5 дней");
    expect(statusLabel({ ...base, state: "failing", problem: "channel" }, t)).toBe("Захват не работает");
    const old = { ...base, state: "incompatible" as const, browsers: [seen("firefox", true, 1)] };
    expect(statusLabel(old, t)).toBe("Старое расширение");
    expect(appIsOlder(old)).toBe(false);
    const newer = { ...old, browsers: [seen("firefox", true, 3)] };
    expect(statusLabel(newer, t)).toBe("Обновите Koona Pin");
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

  it("installs from the catalog once it has a page, otherwise in developer mode", async () => {
    await i18n.changeLanguage("ru");
    const t = i18n.t.bind(i18n);
    const sources = {
      edge: { url: "https://microsoftedge.microsoft.com/addons/detail/koona-pin/abc", store: "Edge Add-ons", install: "connect.store_edge", update: "connect.updateStore" },
    } as const;
    const edge = installSteps("edge", sources);
    expect(edge.url).toBe(sources.edge.url);
    expect(t(edge.install)).toBe("Откройте страницу Koona Pin в Edge Add-ons и нажмите «Получить».");
    expect(t("connect.openStore", { store: edge.store })).toBe("Открыть Edge Add-ons");
    expect(t(edge.update)).toMatch(/^Расширение из каталога обновляется само/);
    const chrome = installSteps("chrome", sources);
    expect(chrome.url).toBeNull();
    expect(t(chrome.install)).toMatch(/^Откройте chrome:\/\/extensions/);
  });

  it("installs Chrome and Edge from the Chrome Web Store, Firefox from koona.app", async () => {
    await i18n.changeLanguage("en");
    const t = i18n.t.bind(i18n);
    const chrome = installSteps("chrome");
    expect(chrome).toMatchObject({ store: "Chrome Web Store", install: "connect.store_chrome", update: "connect.updateStore" });
    expect(chrome.url).toMatch(/^https:\/\/chromewebstore\.google\.com\/detail\//);
    // Until Edge Add-ons approves its own page, Edge takes the same one and says why it asks.
    const edge = installSteps("edge");
    expect(edge).toMatchObject({ url: chrome.url, store: "Chrome Web Store", install: "connect.store_edge_chrome", update: "connect.updateStore" });
    expect(t(edge.install)).toMatch(/Chrome Web Store.*other stores/);
    // The signed add-on is on the site's downloads page, which updates it too (NP-018).
    const firefox = installSteps("firefox");
    expect(firefox).toMatchObject({ url: "https://koona.app/pin/downloads/#extension", store: "koona.app", install: "connect.site_firefox" });
    expect(t(firefox.install)).toMatch(/«Add to Firefox»/);
    expect(t(firefox.update)).toMatch(/Firefox checks koona\.app/);
    expect(t("connect.openStore", { store: firefox.store })).toBe("Open koona.app");
  });

  it("puts the problem and every browser into the report", () => {
    const report = captureReport({ ...base, state: "failing", problem: "channel", detail: "Access is denied.", browsers: [seen("chrome")] }, "0.1.0");
    expect(report).toContain("Capture: failing (channel)");
    expect(report).toContain("Detail: Access is denied.");
    expect(report).toContain("Chrome: extension 0.5.0, protocol 2");
    expect(report).toContain("Protocol: 2, system: windows");
  });

  it("gives Chromium a tab of its own on Linux, with Chrome's steps (NP-054)", () => {
    expect(connectTabs({ ...base, system: "windows" })).toEqual(["chrome", "edge", "firefox"]);
    expect(connectTabs({ ...base, system: "linux" })).toEqual(["chrome", "edge", "chromium", "firefox"]);
    expect(tabBrowser("chromium")).toBe("chrome");
    expect(installSteps(tabBrowser("chromium"))).toEqual(installSteps("chrome"));
  });

  it("tells a Linux user to reinstall the package, not Koona Pin (NP-100)", () => {
    const t = i18n.getFixedT("en");
    const failing = (problem: "channel" | "registration" | "host_missing", system: "windows" | "linux") =>
      ({ ...base, state: "failing", problem, system }) as CaptureStatus;
    for (const problem of ["channel", "registration", "host_missing"] as const) {
      expect(problemText(failing(problem, "windows"), t)).toBe(t(`browser.problem_${problem}`));
      expect(problemText(failing(problem, "linux"), t)).toBe(t(`browser.problem_${problem}_linux`));
      expect(problemText(failing(problem, "linux"), t)).not.toContain(".exe");
    }
    expect(problemText(failing("registration", "linux"), t)).toMatch(/Reinstall the koonapin package/);
    expect(problemBanner(failing("registration", "linux"), t)).toBe(t("browser.banner_registration_linux"));
    expect(problemBanner(failing("host_missing", "linux"), t)).toBe(t("browser.banner_host_missing"));
    expect(problemBanner(failing("registration", "windows"), t)).toBe(t("browser.banner_registration"));
  });
});
