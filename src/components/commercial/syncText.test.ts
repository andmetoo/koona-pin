// Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
import { describe, expect, it } from "vitest";
import i18n from "../../i18n";
import { capabilities } from "../../platform/capabilities";
import type { PausedReason, SyncDevice, SyncProblem, SyncStatus, UnavailableReason } from "../../types";
import {
  ago,
  clockAmount,
  clockOffset,
  detailTime,
  deviceDetail,
  deviceKind,
  noticeBanner,
  overviewBanners,
  planEndsBanner,
  platformName,
  PROBLEMS,
  spacedCode,
  statusBanner,
  syncDetails,
  syncPrompt,
  syncSummary,
  syncView,
} from "./syncText";

const t = i18n.getFixedT("en");
// Records, so a reason or a problem added to the contract fails to compile here until it has words.
const PAUSED: Record<PausedReason, true> = {
  offline: true,
  clock_skew: true,
  update_needed: true,
  revoked: true,
  plan: true,
  device_limit: true,
  replaced: true,
  signed_out: true,
  started_over: true,
};
const UNAVAILABLE: Record<UnavailableReason, true> = { no_service: true, not_supporter: true, library_not_ready: true };
const PROBLEM_SET: Record<SyncProblem, true> = Object.fromEntries(PROBLEMS.map((p) => [p, true])) as Record<SyncProblem, true>;

const device = (id: string, name: string, extra: Partial<SyncDevice> = {}): SyncDevice => ({
  id,
  name,
  online: true,
  is_hub: false,
  status: "active",
  last_seen: Date.now(),
  platform: null,
  app: null,
  last_sync_at: null,
  ...extra,
});
const hub = device("hub", "Home iMac", { is_hub: true });
const laptop = device("me", "Office laptop");
const base: SyncStatus = {
  enabled: true,
  available: true,
  phase: { state: "online" },
  is_hub: false,
  hub: "hub",
  device: laptop,
  devices: [hub, laptop],
  pairing: null,
  last_sync_at: new Date().toISOString(),
  error: null,
  hub_change: null,
  notices: [],
  bookmarks: null,
  clock_offset_ms: null,
  update_from: null,
  epoch: null,
};
/** Words, not a key that i18next gave back for want of them. */
const worded = (text: string | undefined) => {
  expect(text).toBeTruthy();
  expect(text).not.toMatch(/^sync\./);
  expect(text).not.toMatch(/\{\{/);
};

describe("sync texts (sheet 46)", () => {
  it("words every pause, every reason sync is unavailable, every problem", () => {
    for (const reason of Object.keys(PAUSED) as PausedReason[]) {
      const banner = statusBanner({ ...base, phase: { state: "paused", reason } }, t, "en");
      worded(banner.title);
      worded(banner.body);
      worded(syncSummary({ ...base, phase: { state: "paused", reason } }, t, "en", "supporter")?.text);
    }
    for (const reason of Object.keys(UNAVAILABLE) as UnavailableReason[]) worded(statusBanner({ ...base, phase: { state: "unavailable", reason } }, t, "en").title);
    expect(Object.keys(PROBLEM_SET)).toHaveLength(PROBLEMS.length);
    for (const problem of PROBLEMS) {
      const banner = statusBanner({ ...base, error: problem }, t, "en");
      if (problem === "stale_sign_in") continue; // said in the start-over dialog
      expect(banner.id).toBe(`problem:${problem}`);
      worded(banner.title);
      worded(banner.body);
    }
  });

  it("says synced, the main computer away, or the others offline", () => {
    expect(statusBanner(base, t, "en")).toMatchObject({ id: "online", tone: "ok", title: "Synced just now", body: "2 computers" });
    const away = { ...base, devices: [{ ...hub, online: false }, laptop] };
    expect(statusBanner(away, t, "en")).toMatchObject({ id: "online:others_offline", tone: "warn" });
    const pc = device("pc", "Studio PC");
    expect(statusBanner({ ...away, devices: [...away.devices, pc] }, t, "en").body).toBe("Home iMac, the main computer, is offline. It catches up when it's back.");
    expect(syncSummary({ ...base, is_hub: true, device: { ...laptop, is_hub: true } }, t, "en", "settings")?.text).toBe("On · 2 computers · synced just now");
    expect(syncSummary(base, t, "en", "supporter")?.text).toBe("Synced · 2 computers · just now");
    expect(syncSummary({ ...base, enabled: false, phase: { state: "off" } }, t, "en", "supporter")).toBeNull();
    expect(statusBanner({ ...base, phase: { state: "syncing", done: 4210, total: 12480 } }, t, "en").body).toBe("4,210 of 12,480 changes");
  });

  it("keeps the notices until dismissed, and a started-over pause says it once", () => {
    const at = new Date().toISOString();
    expect(noticeBanner({ kind: "device_added", id: "n1", device: "pc", name: "Studio PC", by_name: "Home iMac", at }, t, "en")).toMatchObject({
      title: "Studio PC was added",
      body: "Home iMac added it just now.",
      action: { kind: "review" },
      notice: "n1",
    });
    const startedOver: SyncStatus = {
      ...base,
      phase: { state: "paused", reason: "started_over" },
      notices: [{ kind: "started_over", id: "n2", by: "pc", by_name: "Studio PC", at }],
    };
    const banners = overviewBanners(startedOver, null, t, "en");
    expect(banners.map((b) => b.title)).toEqual(["Sync was started over from Studio PC"]);
    expect(banners[0].action?.kind).toBe("join");
  });

  it("warns a month before Supporter ends", () => {
    const plan = (days: number, status: "active" | "canceling" = "canceling") => ({
      status,
      interval: "year" as const,
      valid_until: new Date(Date.now() + days * 86_400_000).toISOString(),
      renews_at: null,
      offline_until: new Date().toISOString(),
      also_renews: false,
    });
    expect(planEndsBanner(plan(20), t, "en")?.title).toMatch(/^Sync stops on /);
    expect(planEndsBanner(plan(60), t, "en")).toBeNull();
    expect(planEndsBanner(plan(20, "active"), t, "en")).toBeNull();
    expect(planEndsBanner(plan(20), t, "en")?.action?.kind).toBe("renew");
    // A build that sells nothing (a phone's store build until NP-154): the words, no «Renew…».
    capabilities.purchase = "none";
    try {
      expect(planEndsBanner(plan(20), t, "en")?.action).toBeUndefined();
      expect(statusBanner({ ...base, phase: { state: "paused", reason: "plan" } }, t, "en").action).toBeUndefined();
      expect(statusBanner({ ...base, phase: { state: "paused", reason: "signed_out" } }, t, "en").action?.kind).toBe("signIn");
    } finally {
      capabilities.purchase = "paddle";
    }
  });

  it("shows the screen sync asks for", () => {
    expect(syncView({ ...base, enabled: false, phase: { state: "off" } })).toBe("setup");
    const pairing = { ...base, is_hub: true, pairing: { role: "hub" as const, peer: "pc", peer_name: "Studio PC", code: "482913" } };
    expect(syncView(pairing)).toBe("pairHub");
    expect(syncPrompt(pairing)).toBe("pair:pc:482913");
    expect(syncView({ ...base, phase: { state: "pending" } })).toBe("waiting");
    expect(syncView({ ...base, phase: { state: "syncing", done: 1, total: 9 }, last_sync_at: null })).toBe("receiving");
    expect(syncView({ ...base, phase: { state: "syncing", done: 1, total: 9 } })).toBe("overview");
    const asked = { ...base, is_hub: true, hub_change: { role: "hub" as const, peer: "pc", peer_name: "Studio PC" } };
    expect(syncView(asked)).toBe("mainAsked");
    expect(syncPrompt(asked)).toBe("main:pc");
    expect(syncPrompt(base)).toBeNull();
  });

  it("writes times and codes as both screens do", () => {
    const now = Date.UTC(2026, 9, 14, 12);
    expect(ago(now - 10_000, t, "en", now)).toBe("just now");
    expect(ago(now - 3 * 3_600_000, t, "en", now)).toBe("3 hours ago");
    expect(ago(now - 2 * 86_400_000, t, "en", now)).toBe("2 days ago");
    expect(spacedCode("482913")).toBe("482 913");
  });

  it("names the system and the version of each computer, and falls back without them (frame 03)", () => {
    const now = Date.UTC(2026, 9, 14, 12);
    expect(platformName("macos")).toBe("macOS");
    expect(platformName("Windows")).toBe("Windows");
    expect(platformName("freebsd")).toBe("freebsd");
    expect(platformName(null)).toBeNull();
    expect(deviceKind("linux")).toBe("computer");
    expect(deviceKind("android")).toBe("phone");
    expect(deviceKind(null)).toBe("computer");
    const mac = device("me", "Home iMac", { platform: "macos", app: "0.13.0" });
    expect(deviceDetail(mac, t, "en", { version: "0.12.0" }, now)).toBe("macOS · Koona Pin 0.13.0");
    expect(deviceDetail({ ...mac, app: null }, t, "en", { version: "0.12.0" }, now)).toBe("macOS · Koona Pin 0.12.0");
    expect(deviceDetail({ ...mac, platform: null, app: null }, t, "en", { version: "0.12.0" }, now)).toBe("Koona Pin 0.12.0");
    expect(deviceDetail({ ...mac, app: null }, t, "en", { version: "" }, now)).toBe("macOS");
    expect(deviceDetail(device("w", "Office laptop", { platform: "windows" }), t, "en", null, now)).toBe("Windows · online");
    const away = device("l", "Studio PC", { platform: "linux", online: false, last_seen: now - 3 * 3_600_000 });
    expect(deviceDetail(away, t, "en", null, now)).toBe("Linux · last seen 3 hours ago");
    expect(deviceDetail({ ...away, platform: null }, t, "en", null, now)).toBe("Last seen 3 hours ago");
    expect(deviceDetail(device("p", "New one", { status: "pending", platform: "linux" }), t, "en", null, now)).toBe("Linux · waiting for approval");
  });

  it("counts the bookmarks in the synced banner when the library is open (frame 03)", () => {
    const three = { ...base, devices: [hub, laptop, device("pc", "Studio PC")], bookmarks: 12480 };
    expect(statusBanner(three, t, "en")).toMatchObject({ id: "online", title: "Synced just now", body: "3 computers · 12,480 bookmarks" });
    expect(statusBanner({ ...three, bookmarks: 1 }, t, "en").body).toBe("3 computers · 1 bookmark");
    expect(statusBanner({ ...three, bookmarks: null }, t, "en").body).toBe("3 computers");
  });

  it("says how far the clock is off and who has the newer version (frame 11)", () => {
    expect(clockAmount(7 * 60_000 + 12_000, "en")).toBe("7 min");
    expect(clockAmount(-7 * 60_000, "en")).toBe("7 min");
    expect(clockAmount(45_000, "en")).toBe("45 sec");
    expect(clockAmount(3 * 3_600_000 + 60_000, "en")).toBe("3 hr");
    expect(clockAmount(3 * 86_400_000, "en")).toBe("3 days");
    const skew = { ...base, phase: { state: "paused" as const, reason: "clock_skew" as const } };
    expect(statusBanner({ ...skew, clock_offset_ms: 7 * 60_000 + 12_000 }, t, "en")).toMatchObject({
      id: "paused:clock_skew",
      title: "This computer's clock is 7 min off",
      body: "Set the right time to keep syncing.",
    });
    expect(statusBanner({ ...skew, clock_offset_ms: -2 * 3_600_000 }, t, "en").title).toBe("This computer's clock is 2 hr off");
    expect(statusBanner(skew, t, "en").title).toBe("This computer's clock is off");
    const update = { ...base, phase: { state: "paused" as const, reason: "update_needed" as const } };
    expect(statusBanner({ ...update, update_from: "hub" }, t, "en")).toMatchObject({ title: "Update Koona Pin to keep syncing", body: "Home iMac has a newer version." });
    expect(statusBanner({ ...update, update_from: "gone" }, t, "en").body).toBe("Another of your computers has a newer version.");
    expect(statusBanner(update, t, "en").body).toBe("Another of your computers has a newer version.");
  });

  it("fills Sync details: the clock, the key's generation and what each computer has (frame 09)", () => {
    const now = new Date(2026, 9, 14, 15, 0).getTime();
    const at = (h: number, m: number, daysBack = 0) => new Date(2026, 9, 14 - daysBack, h, m).toISOString();
    expect(clockOffset(400, "en")).toBe("+0.4 sec");
    expect(clockOffset(-1200, "en")).toBe("-1.2 sec");
    expect(clockOffset(0, "en")).toBe("0 sec");
    expect(clockOffset(42_400, "en")).toBe("+42 sec");
    expect(clockOffset(3 * 3_600_000, "en")).toBe("+3 hr");
    expect(clockOffset(-7 * 60_000, "en")).toBe("-7 min");
    expect(detailTime(at(14, 2), t, "en", now)).toBe("2:02 PM");
    expect(detailTime(at(18, 40, 1), t, "en", now)).toBe("yesterday 6:40 PM");
    const status: SyncStatus = {
      ...base,
      device: { ...laptop, id: "7f3a0000-0000-0000-0000-00000000c21e" },
      last_sync_at: at(14, 2),
      clock_offset_ms: 400,
      epoch: 2,
      devices: [
        { ...hub, last_sync_at: at(14, 2) },
        { ...laptop, id: "7f3a0000-0000-0000-0000-00000000c21e" },
        device("pc", "Studio PC", { online: false, last_sync_at: at(18, 40, 1) }),
        device("new", "New PC", { online: false }),
      ],
    };
    const details = syncDetails(status, t, "en", now);
    expect(details).toMatchObject({
      state: "Online · synced 2:02 PM",
      main: "Home iMac",
      device: "Office laptop · 7f3a…c21e",
      clock: "+0.4 sec against the server",
      key: "Generation 2",
    });
    expect(details.computers.map((d) => `${d.name}: ${d.value}`)).toEqual([
      "Home iMac: up to 2:02 PM",
      "Studio PC: up to yesterday 6:40 PM · offline",
      "New PC: nothing yet · offline",
    ]);
    const unknown = syncDetails({ ...status, last_sync_at: null, clock_offset_ms: null, epoch: null }, t, "en", now);
    expect(unknown).toMatchObject({ state: "Online · not synced yet", clock: "Not known yet", key: "Not known yet" });
    expect(syncDetails({ ...status, phase: { state: "paused", reason: "clock_skew" } }, t, "en", now).state).toBe("Paused · check your clock · synced 2:02 PM");
  });
});
