import { describe, expect, it } from "vitest";
import i18n from "../../../i18n";
import type { Plan, SupporterStatus, SyncDevice, SyncStatus } from "../../../types";
import { deviceChips, planLine, sizeName, syncCard } from "./youText";

const t = i18n.getFixedT("en");

const plan = (more: Partial<Plan>): Plan => ({
  status: "active",
  interval: "year",
  valid_until: "2027-10-09T12:00:00Z",
  renews_at: "2027-10-09T12:00:00Z",
  offline_until: "2026-11-09T12:00:00Z",
  also_renews: false,
  ...more,
});

const device = (id: string, name: string, more: Partial<SyncDevice> = {}): SyncDevice => ({
  id,
  name,
  online: true,
  is_hub: false,
  status: "active",
  last_seen: null,
  platform: null,
  app: null,
  last_sync_at: null,
  ...more,
});

const phone = device("phone", "Pixel");
const imac = device("imac", "Home iMac", { is_hub: true });
const laptop = device("laptop", "Office laptop", { online: false });

const sync = (more: Partial<SyncStatus> = {}): SyncStatus => ({
  enabled: true,
  available: true,
  phase: { state: "online" },
  is_hub: false,
  hub: "imac",
  device: phone,
  devices: [imac, phone, laptop, device("old", "Old PC", { status: "revoked" })],
  pairing: null,
  last_sync_at: new Date().toISOString(),
  error: null,
  hub_change: null,
  notices: [],
  bookmarks: 120,
  clock_offset_ms: null,
  update_from: null,
  epoch: 1,
  ...more,
});

const supporter = (more: Partial<SupporterStatus> = {}): SupporterStatus => ({
  available: true,
  sandbox: false,
  email: null,
  plan: plan({}),
  check_failed: false,
  plan_unknown: false,
  awaiting_sign_in: false,
  ...more,
});

describe("the Supporter card's line", () => {
  it("thanks and says when a subscription renews or ends", () => {
    expect(planLine(plan({}), t, "en-GB")).toBe("Thank you · yearly plan, renews 9 Oct 2027");
    expect(planLine(plan({ interval: "month" }), t, "en-GB")).toBe("Thank you · monthly plan, renews 9 Oct 2027");
    expect(planLine(plan({ status: "canceling", renews_at: null }), t, "en-GB")).toBe("Thank you · yearly plan, ends 9 Oct 2027");
  });

  it("says until when five years run, and what needs the person", () => {
    expect(planLine(plan({ interval: "five_years", renews_at: null }), t, "en-GB")).toBe("Thank you · 5 years, until 9 Oct 2027");
    expect(planLine(plan({ interval: "five_years", also_renews: true }), t, "en-GB")).toBe(t("supporter.alsoRenews"));
    expect(planLine(plan({ status: "past_due" }), t, "en-GB")).toBe(t("supporter.pastDue"));
    // Where nothing is sold: no card to update, no Manage.
    expect(planLine(plan({ status: "past_due" }), t, "en-GB", false)).toMatch(/^The last payment didn't go through · Supporter until \d+ \w+ \d{4}$/);
    expect(planLine(plan({ interval: "five_years", also_renews: true }), t, "en-GB", false)).toBe("Your subscription still renews as well");
  });

  it("sends a plan paid through Google Play to Google Play, in any build (NP-154)", () => {
    for (const sells of [true, false]) {
      expect(planLine(plan({ status: "past_due", store: "play" }), t, "en-GB", sells)).toBe("The renewal didn't go through — fix the payment in Google Play");
      expect(planLine(plan({ interval: "five_years", also_renews: true, store: "play" }), t, "en-GB", sells)).toBe(t("supporter.alsoRenewsPlay"));
    }
    expect(planLine(plan({ store: "play" }), t, "en-GB", false)).toBe("Thank you · yearly plan, renews 9 Oct 2027");
  });
});

describe("the Sync shelf", () => {
  it("is hidden in a build without Supporter or a relay", () => {
    expect(syncCard(null, sync(), t, "en")).toEqual({ kind: "hidden" });
    expect(syncCard(supporter({ available: false }), sync(), t, "en")).toEqual({ kind: "hidden" });
    expect(syncCard(supporter(), sync({ available: false }), t, "en")).toEqual({ kind: "hidden" });
  });

  it("explains the perk without a plan, and offers to set up sync that is off", () => {
    expect(syncCard(supporter({ plan: null }), sync(), t, "en").kind).toBe("free");
    expect(syncCard(supporter(), sync({ enabled: false }), t, "en").kind).toBe("off");
    expect(syncCard(supporter(), sync({ phase: { state: "off" } }), t, "en").kind).toBe("off");
  });

  it("says when it synced, how many devices and which is the main computer", () => {
    const card = syncCard(supporter(), sync(), t, "en");
    expect(card).toMatchObject({ kind: "on", circle: "synced", title: "Synced just now", body: "3 devices · Home iMac is the main computer", busy: false });
  });

  it("uses the desktop's words for other states", () => {
    const syncing = syncCard(supporter(), sync({ phase: { state: "syncing", done: 3, total: 10 } }), t, "en");
    expect(syncing).toMatchObject({ kind: "on", circle: "syncing", title: t("sync.banner.syncing"), busy: true });
    const offline = syncCard(supporter(), sync({ phase: { state: "paused", reason: "offline" } }), t, "en");
    expect(offline).toMatchObject({ circle: "offline", title: t("sync.banner.offline"), body: t("sync.banner.offlineBody") });
    const error = syncCard(supporter(), sync({ error: "relay_refused" }), t, "en");
    expect(error).toMatchObject({ circle: "error", title: t("sync.problem.relay_refused", { name: "Home iMac" }) });
  });

  it("lists this device first, then the others that sync", () => {
    expect(deviceChips(sync()).map((d) => d.name)).toEqual(["Pixel", "Home iMac", "Office laptop"]);
    // Not in the account's list yet: this device still comes first.
    expect(deviceChips(sync({ devices: [imac] })).map((d) => d.name)).toEqual(["Pixel", "Home iMac"]);
  });
});

describe("the reader's text size by name", () => {
  it("names the slider's sizes in four steps", () => {
    expect([15, 16, 17, 18, 19, 20, 22, 24].map(sizeName)).toEqual(["small", "small", "default", "default", "large", "large", "largest", "largest"]);
  });
});
