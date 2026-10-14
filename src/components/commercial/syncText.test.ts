// Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
import { describe, expect, it } from "vitest";
import i18n from "../../i18n";
import type { PausedReason, SyncDevice, SyncProblem, SyncStatus, UnavailableReason } from "../../types";
import { ago, noticeBanner, overviewBanners, planEndsBanner, PROBLEMS, spacedCode, statusBanner, syncPrompt, syncSummary, syncView } from "./syncText";

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
});
