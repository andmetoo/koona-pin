import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import type { Plan, SupporterStatus } from "../types";
import { planLink, planState } from "./supporterFlow";

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
const supporter = (more: Partial<Plan>, check_failed = false): SupporterStatus => ({
  available: true,
  sandbox: false,
  email: "anna@example.com",
  plan: plan(more),
  check_failed,
  plan_unknown: false,
  awaiting_sign_in: false,
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
