import { describe, expect, it } from "vitest";
import i18n from "../../../i18n";
import type { PlayOffer, PlayState } from "../../../types";
import { failureLine, playBadge, playPlans, playPriceLine, playStep, playUnavailable, resumedStep } from "./playFlow";

const t = i18n.getFixedT("en");

const price = (price: string, micros: number, period: string | null, currency = "EUR") => ({ price, currency, micros, period });
const offer = (more: Partial<PlayOffer> = {}): PlayOffer => ({
  available: true,
  month: price("€2.00", 2_000_000, "P1M"),
  year: price("€20.00", 20_000_000, "P1Y"),
  five_years: price("€50.00", 50_000_000, null),
  suspended: false,
  ...more,
});

describe("the Play purchase's steps", () => {
  it("follow the server's verdict", () => {
    const steps: Record<PlayState, ReturnType<typeof playStep>> = {
      paid: { step: "paid", failure: null },
      email: { step: "email", failure: null },
      sign_in: { step: "code", failure: null },
      owned: { step: "owner", failure: null },
      suspended: { step: "suspended", failure: null },
      pending: { step: "pending", failure: null },
      already_supporter: { step: "alreadySupporter", failure: null },
      other_account: { step: "otherAccount", failure: null },
      canceled: { step: "plans", failure: null },
      invalid: { step: "plans", failure: "invalid" },
      unavailable: { step: "plans", failure: "unavailable" },
      error: { step: "plans", failure: "failed" },
    };
    for (const [state, expected] of Object.entries(steps)) expect(playStep(state as PlayState), state).toEqual(expected);
  });

  it("asks for the code only when one was sent, and to sign in to the account that owns the purchase otherwise", () => {
    // `sign_in`: a code went to the email given; `owned`: bound already, or owned by this Google
    // account, with nobody signed in here and no code sent (billing/play.rs).
    expect(playStep("sign_in").step).toBe("code");
    expect(playStep("owned").step).toBe("owner");
  });

  it("resume a purchase still waiting when the sheet opens, and nothing that finished", () => {
    expect(resumedStep(undefined)).toBe("plans");
    expect(resumedStep({ state: "email", email: null })).toBe("email");
    expect(resumedStep({ state: "sign_in", email: "anna@example.com" })).toBe("code");
    expect(resumedStep({ state: "pending", email: null })).toBe("pending");
    for (const state of ["paid", "already_supporter", "other_account", "owned", "suspended", "canceled", "invalid", "unavailable", "error"] as const)
      expect(resumedStep({ state, email: null }), state).toBe("plans");
    expect(resumedStep({ state: "sign_in", email: null })).toBe("plans");
  });

  it("say each failure in its own words", () => {
    expect(failureLine("failed", t)).toBe(t("phone.supporter.play.failed"));
    expect(failureLine("invalid", t)).toBe(t("phone.supporter.play.invalid"));
    expect(failureLine("unavailable", t)).toBe(t("phone.supporter.play.unavailable"));
  });
});

describe("the Play plans", () => {
  it("are the yearly first, the monthly, five years; only those Play sells once it answers", () => {
    expect(playPlans(null)).toEqual(["year", "month", "five_years"]);
    expect(playPlans(offer())).toEqual(["year", "month", "five_years"]);
    expect(playPlans(offer({ five_years: null }))).toEqual(["year", "month"]);
  });

  it("show Play's price to the letter with its period", () => {
    expect(playPriceLine("year", price("€20.00", 20_000_000, "P1Y"), t)).toBe("€20.00 a year");
    expect(playPriceLine("month", price("2,00 €", 2_000_000, "P1M"), t)).toBe("2,00 € a month");
    expect(playPriceLine("five_years", price("€50.00", 50_000_000, null), t)).toBe("€50.00 once");
    // The period is Play's: a yearly card with Play's yearly period, whatever the card.
    expect(playPriceLine("month", price("€20.00", 20_000_000, "P1Y"), t)).toBe("€20.00 a year");
  });

  it("say Play sells nothing here when it has no plan, as when it is not there", () => {
    expect(playUnavailable(null)).toBe(false);
    expect(playUnavailable(offer())).toBe(false);
    expect(playUnavailable(offer({ month: null, year: null, five_years: null }))).toBe(true);
    expect(playUnavailable(offer({ available: false }))).toBe(true);
  });

  it("carry a badge only where Play's prices make it true", () => {
    expect(playBadge("year", offer(), t)).toBe("2 months free");
    expect(playBadge("five_years", offer(), t)).toBe("Save 50%");
    expect(playBadge("month", offer(), t)).toBeNull();
    // A yearly price above ten months, five years above half of five years' renewals.
    expect(playBadge("year", offer({ year: price("€22.00", 22_000_000, "P1Y") }), t)).toBeNull();
    expect(playBadge("five_years", offer({ five_years: price("€60.00", 60_000_000, null) }), t)).toBeNull();
    // Another currency, or no prices yet: nothing to compare.
    expect(playBadge("year", offer({ month: price("$2.00", 2_000_000, "P1M", "USD") }), t)).toBeNull();
    expect(playBadge("year", null, t)).toBeNull();
  });
});
