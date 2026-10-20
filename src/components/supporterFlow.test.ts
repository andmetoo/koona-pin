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
      expect(action({ store, interval: "five_years", renews_at: null, also_renews: true })).toBe("manage");
    }
    expect(planState(supporter({ status: "past_due" }), t, "en").status).toBe(t("supporter.pastDue"));
  });

  it("is Google Play for a plan paid through Google Play, never Paddle's portal", () => {
    expect(action({ store: "play" })).toBe("manageInPlay");
    expect(action({ store: "play", status: "canceling", renews_at: null })).toBe("manageInPlay");
    expect(action({ store: "play", status: "past_due" })).toBe("fixInPlay");
    expect(action({ store: "play", interval: "five_years", renews_at: null, also_renews: true })).toBe("manageInPlay");
    const pastDue = planState(supporter({ store: "play", status: "past_due" }), t, "en");
    expect(pastDue).toMatchObject({ status: t("supporter.pastDuePlay"), tone: "danger" });
    expect(pastDue.status).not.toMatch(/card/);
    expect(planState(supporter({ store: "play", interval: "five_years", renews_at: null, also_renews: true }), t, "en").status).toBe(
      t("supporter.alsoRenewsPlay"),
    );
  });

  it("is the same for both stores where there is nothing to manage or the plan is not checked", () => {
    for (const store of ["paddle", "play"] as const) {
      expect(action({ store, interval: "five_years", renews_at: null })).toBe("close");
      expect(action({ store }, true)).toBe("retry");
    }
  });

  it("opens the page of its store", () => {
    expect(planLink("manage")).toBe("portal");
    expect(planLink("updateCard")).toBe("portal");
    expect(planLink("manageInPlay")).toBe("play");
    expect(planLink("fixInPlay")).toBe("play");
    expect(planLink("retry")).toBeNull();
    expect(planLink("close")).toBeNull();
  });
});
