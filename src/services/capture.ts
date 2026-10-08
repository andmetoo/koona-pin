import type { TFunction } from "i18next";
import { Browser, BrowserStatus, CaptureStatus } from "../types";

export const browsers: Browser[] = ["chrome", "edge", "firefox"];
export const browserName: Record<Browser, string> = { chrome: "Chrome", edge: "Edge", firefox: "Firefox" };

/**
 * A tab of «Connect browser»: on Linux Chromium has its own (Р-45), with the
 * steps of Chrome — the same store, `chrome://extensions` and toolbar.
 */
export type ConnectTab = Browser | "chromium";
export const connectTabName: Record<ConnectTab, string> = { ...browserName, chromium: "Chromium" };
export const connectTabs = (status: CaptureStatus | null): ConnectTab[] =>
  status?.system === "linux" ? ["chrome", "edge", "chromium", "firefox"] : browsers;
/** The browser whose texts a tab shows. */
export const tabBrowser = (tab: ConnectTab): Browser => (tab === "chromium" ? "chrome" : tab);

/** Dot colour of the browser status (guidelines, «Статус браузера»). */
export function statusColor(status: CaptureStatus | null): string {
  switch (status?.state) {
    case "connected":
      return "var(--np-green)";
    case "lost":
    case "incompatible":
      return "var(--np-ochre)";
    case "failing":
      return "var(--np-danger)";
    default:
      return "var(--np-faint)";
  }
}

/** The browser that wrote recently with another protocol, if any. */
export function incompatible(status: CaptureStatus | null): BrowserStatus | undefined {
  return status?.browsers.find((b) => b.recent && !b.compatible);
}

/** An extension newer than the app: the app is the one to update. */
export function appIsOlder(status: CaptureStatus | null): boolean {
  const browser = incompatible(status);
  return !!browser && (browser.extension_protocol ?? 0) > (status?.protocol ?? 0);
}

/** The line at the bottom of the sidebar. */
export function statusLabel(status: CaptureStatus | null, t: TFunction): string {
  switch (status?.state) {
    case "connected":
      return t("browser.ready");
    case "lost":
      return t("browser.lost", { count: status.days_silent ?? 3 });
    case "incompatible":
      return appIsOlder(status) ? t("browser.updateApp") : t("browser.update");
    case "failing":
      return t("browser.failing");
    case "none":
      return t("browser.notConnected");
    default:
      return t("browser.checking");
  }
}

/** Settings → Browser when capture cannot work; on Linux it names the package to reinstall (Р-52, п. 5). */
export function problemText(status: CaptureStatus | null, t: TFunction): string {
  const problem = status?.problem ?? "channel";
  return status?.system === "linux" ? t(`browser.problem_${problem}_linux`) : t(`browser.problem_${problem}`);
}

/** The banner above the library; on Linux only the registration line reads differently. */
export function problemBanner(status: CaptureStatus | null, t: TFunction): string {
  const problem = status?.problem ?? "channel";
  return status?.system === "linux" && problem === "registration"
    ? t("browser.banner_registration_linux")
    : t(`browser.banner_${problem}`);
}

/** «Chrome, Edge»: the browsers that wrote within three days. */
export function connectedNames(status: CaptureStatus | null): string {
  return (status?.browsers ?? [])
    .filter((b) => b.recent && b.compatible)
    .map((b) => browserName[b.browser])
    .join(", ");
}

/** «Last saved today at 11:48 from Chrome». */
export function lastSaved(status: CaptureStatus | null, t: TFunction, language: string, now = new Date()): string {
  const last = status?.last_capture;
  if (!last) return t("browser.noSaves");
  const date = new Date(last.at);
  const time = date.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" });
  const browser = browserName[last.browser];
  return date.toDateString() === now.toDateString()
    ? t("browser.lastSavedToday", { time, browser })
    : t("browser.lastSavedOn", { date: date.toLocaleDateString(language, { day: "numeric", month: "long" }), time, browser });
}

/**
 * Catalog pages of the extension, filled in once a catalog approves it
 * (NP-017, `extension/store/README.md`). A browser with a page installs from
 * the catalog; the others keep the developer-mode steps.
 */
export const storeLinks: Partial<Record<StoreBrowser, string>> = {};
const storeName = { chrome: "Chrome Web Store", edge: "Edge Add-ons" } as const;
type StoreBrowser = keyof typeof storeName;
const inStore = (browser: Browser): browser is StoreBrowser => browser in storeName;

/** Step 1 and the update hint of the connect dialog for this browser. */
export function installSteps(browser: Browser, links = storeLinks) {
  const url = inStore(browser) ? links[browser] : undefined;
  return url && inStore(browser)
    ? { url, store: storeName[browser], install: `connect.store_${browser}` as const, update: "connect.updateStore" as const }
    : { url: null, store: null, install: `connect.install_${browser}` as const, update: `connect.update_${browser}` as const };
}

/** The browser to show first in the connect dialog: the last one that saved. */
export function preferredBrowser(status: CaptureStatus | null): Browser {
  return status?.last_capture?.browser ?? status?.browsers.find((b) => b.recent)?.browser ?? "chrome";
}

/** What «Скопировать отчёт» puts on the clipboard. */
export function captureReport(status: CaptureStatus, version: string): string {
  return [
    `Koona Pin ${version}`,
    `Capture: ${status.state}${status.problem ? ` (${status.problem})` : ""}`,
    status.detail ? `Detail: ${status.detail}` : "",
    `Protocol: ${status.protocol}, system: ${status.system}`,
    ...status.browsers.map(
      (b) => `${browserName[b.browser]}: extension ${b.extension_version ?? "?"}, protocol ${b.extension_protocol ?? "?"}, last seen ${b.last_seen}`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
}
