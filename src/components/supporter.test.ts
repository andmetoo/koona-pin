import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import type { Plan, SupporterPrices, SupporterStatus } from "../types";
import { cancelsPlay, paymentsKey, refundKey } from "./accountDeletion";
import { planLink, planState, rememberedPrices, rememberPrices } from "./supporterFlow";

const t = i18n.getFixedT("en");

const plan = (more: Partial<Plan> = {}): Plan => ({
  status: "active",
  interval: "year",
  valid_until: "2027-10-09T12:00:00Z",
  renews_at: "2027-10-09T12:00:00Z",
  offline_until: "2026-11-09T12:00:00Z",
  also_renews: false,
  ...more,
});
const supporter = (more: Partial<Plan>, check_failed = false): SupporterStatus => ({
  available: true,
  sandbox: false,
  email: "anna@example.com",
  plan: plan(more),
  check_failed,
  plan_unknown: false,
  awaiting_sign_in: false,
});
const supporterStatus = (more: Partial<SupporterStatus> = {}): SupporterStatus => ({
  available: true,
  sandbox: false,
  email: "anna@example.com",
  plan: plan(),
  check_failed: false,
  plan_unknown: false,
  awaiting_sign_in: false,
  ...more,
});
const action = (more: Partial<Plan>, check_failed = false) => planState(supporter(more, check_failed), t, "en").action;

describe("the plan's action by where it is paid", () => {
  it("is Paddle's portal for a plan paid through Paddle, or one from a server that does not say", () => {
    for (const store of [undefined, "paddle"] as const) {
      expect(action({ store })).toBe("manage");
      expect(action({ store, status: "canceling", renews_at: null })).toBe("manage");
      expect(action({ store, status: "past_due" })).toBe("updateCard");
      expect(action({ store, interval: "lifetime", renews_at: null, also_renews: true })).toBe("manage");
    }
    expect(planState(supporter({ status: "past_due" }), t, "en").status).toBe(t("supporter.pastDue"));
  });

  it("is Google Play for a plan paid through Google Play, never Paddle's portal", () => {
    expect(action({ store: "play" })).toBe("manageInPlay");
    expect(action({ store: "play", status: "canceling", renews_at: null })).toBe("manageInPlay");
    expect(action({ store: "play", status: "past_due" })).toBe("fixInPlay");
    expect(action({ store: "play", interval: "lifetime", renews_at: null, also_renews: true })).toBe("manageInPlay");
    const pastDue = planState(supporter({ store: "play", status: "past_due" }), t, "en");
    expect(pastDue).toMatchObject({ status: t("supporter.pastDuePlay"), tone: "danger" });
    expect(pastDue.status).not.toMatch(/card/);
    expect(planState(supporter({ store: "play", interval: "lifetime", renews_at: null, also_renews: true }), t, "en").status).toBe(
      t("supporter.alsoRenewsPlay"),
    );
  });

  it("is the App Store for a plan paid through the App Store, which the server cannot stop", () => {
    expect(action({ store: "appstore" })).toBe("manageInAppStore");
    expect(action({ store: "appstore", status: "canceling", renews_at: null })).toBe("manageInAppStore");
    expect(action({ store: "appstore", status: "past_due" })).toBe("fixInAppStore");
    // The one-time purchase bought over a live App Store subscription: cancel it in Settings.
    const both = planState(supporter({ store: "appstore", interval: "lifetime", renews_at: null, also_renews: true }), t, "en");
    expect(both).toMatchObject({ status: t("supporter.alsoRenewsAppStore"), action: "manageInAppStore" });
    expect(both.status).toMatch(/Settings/);
    expect(planState(supporter({ store: "appstore", status: "past_due" }), t, "en").status).toBe(t("supporter.pastDueAppStore"));
    // A Sandbox one-time purchase has its one day: the paid-until line, nothing to manage.
    const sandboxDay = planState(supporter({ store: "appstore", interval: "lifetime", renews_at: null }), t, "en");
    expect(sandboxDay.action).toBe("close");
    expect(sandboxDay.status).not.toBe(t("supporter.lifetimeLine"));
  });

  it("is the same for every store where there is nothing to manage or the plan is not checked", () => {
    for (const store of ["paddle", "play", "appstore"] as const) {
      expect(action({ store, interval: "lifetime", renews_at: null })).toBe("close");
      expect(action({ store }, true)).toBe("retry");
    }
  });

  it("opens the page of its store", () => {
    expect(planLink("manage")).toBe("portal");
    expect(planLink("updateCard")).toBe("portal");
    expect(planLink("manageInPlay")).toBe("play");
    expect(planLink("fixInPlay")).toBe("play");
    expect(planLink("manageInAppStore")).toBe("appstore");
    expect(planLink("fixInAppStore")).toBe("appstore");
    expect(planLink("retry")).toBeNull();
    expect(planLink("close")).toBeNull();
  });
});

describe("remembered Paddle prices (NP-066)", () => {
  const storage = new Map<string, string>();
  const eur: SupporterPrices = {
    month: { price_id: "m", total: "€1.49", currency: "EUR" },
    year: { price_id: "y", total: "€9.99", currency: "EUR" },
    lifetime: { price_id: "l", total: "€29.99", currency: "EUR" },
  };
  beforeEach(() => {
    storage.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, String(value)),
      removeItem: (key: string) => void storage.delete(key),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("remembers prices and returns them while fresh (within 7 days)", () => {
    expect(rememberedPrices()).toBeNull();
    rememberPrices(eur);
    expect(rememberedPrices()).toEqual(eur);
    storage.set("koonapin.supporterPrices", JSON.stringify({ at: Date.now() - 86_400_000, prices: eur }));
    expect(rememberedPrices()).toEqual(eur);
    // Explicitly null lifetime (not sold) still counts as complete.
    const withoutLifetime: SupporterPrices = { ...eur, lifetime: null };
    storage.set("koonapin.supporterPrices", JSON.stringify({ at: Date.now() - 86_400_000, prices: withoutLifetime }));
    expect(rememberedPrices()).toEqual(withoutLifetime);
  });

  it("forgets prices older than 7 days, from the future, or stored under the legacy five_years key", () => {
    storage.set("koonapin.supporterPrices", JSON.stringify({ at: Date.now() - 8 * 86_400_000, prices: eur }));
    expect(rememberedPrices()).toBeNull();
    storage.set("koonapin.supporterPrices", JSON.stringify({ at: Date.now() + 60_000, prices: eur }));
    expect(rememberedPrices()).toBeNull();
    const legacy = {
      month: eur.month,
      year: eur.year,
      five_years: { price_id: "f", total: "€50.00", currency: "EUR" },
    };
    storage.set("koonapin.supporterPrices", JSON.stringify({ at: Date.now() - 86_400_000, prices: legacy }));
    expect(rememberedPrices()).toBeNull();
  });
});

describe("deleting the account", () => {
  it("says Google Play subscriptions are cancelled only in the Play build", () => {
    // Vitest runs as a desktop build (purchase "paddle"): never, even for a plan paid through Play.
    expect(cancelsPlay(plan({ store: "play" }))).toBe(false);
    expect(cancelsPlay(null)).toBe(false);
  });

  it("says an App Store subscription is the person's to cancel in Settings: the server cannot stop it", () => {
    expect(t(paymentsKey(plan({ store: "appstore" })))).toMatch(/Settings/);
    expect(paymentsKey(plan({ store: "appstore", interval: "lifetime", renews_at: null, also_renews: true }))).toBe("deleteAccount.paymentsAppStore");
    expect(paymentsKey(plan({ store: "appstore", interval: "lifetime", renews_at: null }))).toBe("deleteAccount.payments");
    for (const store of [undefined, "paddle", "play"] as const) expect(paymentsKey(plan({ store }))).toBe("deleteAccount.payments");
    expect(paymentsKey(null)).toBe("deleteAccount.payments");
  });

  it("says the one-time purchase goes with the account, a subscription's paid time is not refunded", () => {
    expect(t(refundKey(plan({ interval: "lifetime", valid_until: null, renews_at: null })))).toMatch(/^Your one-time purchase goes with the account/);
    // A Play license tester's test day, and subscriptions, keep the paid-time sentence.
    for (const p of [plan({ interval: "lifetime", renews_at: null }), plan(), plan({ interval: "month" }), null]) expect(refundKey(p)).toBe("deleteAccount.refund");
  });

  it("puts a scheduled deletion on the plan's line, after what needs doing", () => {
    const scheduled = planState(supporterStatus({ delete_at: "2027-10-09T12:00:00Z", plan: plan({ status: "canceling", renews_at: null }) }), t, "en");
    expect(scheduled).toMatchObject({ status: "Account will be deleted on October 9, 2027", tone: "amber", action: "manage" });
    // A plan not checked, or a failed payment, still says so.
    expect(planState(supporterStatus({ delete_at: "2027-10-09T12:00:00Z", check_failed: true }), t, "en").action).toBe("retry");
    expect(planState(supporterStatus({ delete_at: "2027-10-09T12:00:00Z", plan: plan({ status: "past_due" }) }), t, "en").tone).toBe("danger");
  });
});
