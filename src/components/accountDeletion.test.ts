import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import type { Plan, SupporterStatus } from "../types";
import { paidTimeLeft } from "./accountDeletion";
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
  it("offers to wait only while paid time is left", () => {
    const now = Date.parse("2026-10-21T12:00:00Z");
    expect(paidTimeLeft(plan(), now)).toBe(true);
    expect(paidTimeLeft(plan({ valid_until: "2026-10-20T12:00:00Z" }), now)).toBe(false);
    expect(paidTimeLeft(null, now)).toBe(false);
  });

  it("puts a scheduled deletion on the plan's line, after what needs doing", () => {
    const scheduled = planState(supporter({ delete_at: "2027-10-09T12:00:00Z", plan: plan({ status: "canceling", renews_at: null }) }), t, "en");
    expect(scheduled).toMatchObject({ status: "Account will be deleted on October 9, 2027", tone: "amber", action: "manage" });
    // A plan not checked, or a failed payment, still says so.
    expect(planState(supporter({ delete_at: "2027-10-09T12:00:00Z", check_failed: true }), t, "en").action).toBe("retry");
    expect(planState(supporter({ delete_at: "2027-10-09T12:00:00Z", plan: plan({ status: "past_due" }) }), t, "en").tone).toBe("danger");
  });
});
