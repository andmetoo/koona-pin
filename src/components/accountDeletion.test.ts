import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import type { Plan, SupporterStatus } from "../types";
import { cancelsPlay, refundKey } from "./accountDeletion";
import { planState } from "./supporterFlow";

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
const supporter = (more: Partial<SupporterStatus> = {}): SupporterStatus => ({
  available: true,
  sandbox: false,
  email: "anna@example.com",
  plan: plan(),
  check_failed: false,
  plan_unknown: false,
  awaiting_sign_in: false,
  ...more,
});

describe("deleting the account", () => {
  it("says Google Play subscriptions are cancelled only in the Play build", () => {
    // Vitest runs as a desktop build (purchase "paddle"): never, even for a plan paid through Play.
    expect(cancelsPlay(plan({ store: "play" }))).toBe(false);
    expect(cancelsPlay(null)).toBe(false);
  });

  it("says the one-time purchase goes with the account, a subscription's paid time is not refunded", () => {
    expect(t(refundKey(plan({ interval: "lifetime", valid_until: null, renews_at: null })))).toMatch(/^Your one-time purchase goes with the account/);
    // A Play license tester's test day, and subscriptions, keep the paid-time sentence.
    for (const p of [plan({ interval: "lifetime", renews_at: null }), plan(), plan({ interval: "month" }), null]) expect(refundKey(p)).toBe("deleteAccount.refund");
  });

  it("puts a scheduled deletion on the plan's line, after what needs doing", () => {
    const scheduled = planState(supporter({ delete_at: "2027-10-09T12:00:00Z", plan: plan({ status: "canceling", renews_at: null }) }), t, "en");
    expect(scheduled).toMatchObject({ status: "Account will be deleted on October 9, 2027", tone: "amber", action: "manage" });
    // A plan not checked, or a failed payment, still says so.
    expect(planState(supporter({ delete_at: "2027-10-09T12:00:00Z", check_failed: true }), t, "en").action).toBe("retry");
    expect(planState(supporter({ delete_at: "2027-10-09T12:00:00Z", plan: plan({ status: "past_due" }) }), t, "en").tone).toBe("danger");
  });
});
