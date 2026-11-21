import { test, expect, type Page } from "@playwright/test";
import { openApp } from "../fixtures/app";

/** From the open plans: «I'm already a Supporter», the email, the code. Returns the sign-in step's height. */
async function signInAsSupporter(page: Page, email: string) {
  await page.getByRole("dialog", { name: "Support Koona Pin" }).getByRole("button", { name: "I'm already a Supporter" }).click();
  const signIn = page.getByRole("dialog", { name: "Sign in as a Supporter" });
  const height = Math.round((await signIn.boundingBox())!.height);
  await signIn.getByLabel("Email").fill(email);
  await signIn.getByRole("button", { name: "Send code" }).click();
  const code = page.getByRole("dialog", { name: "Check your email" });
  await code.getByLabel("Code").fill("482913");
  await code.getByRole("button", { name: "Sign in", exact: true }).click();
  return height;
}

test.beforeEach(({ page }) => openApp(page, { cards: 6 }));

test("Supporter: nothing in a build that does not sell it; the row, the plan, the payment in the browser, the badge and its dialog (NP-066, sheet 45)", async ({ page }) => {
  // A build without the account service: no row; Settings never has a plan.
  await expect(page.locator("[data-plan-row]")).toHaveCount(0);
  await page.evaluate(() => localStorage.setItem("koonapin.demo.supporter", "free"));
  await page.reload();
  const row = page.locator("[data-plan-row]");
  await expect(row).toHaveAttribute("data-plan-row", "free");
  await expect(row).toHaveText("Support Koona Pin");
  await row.click();
  const plans = page.getByRole("dialog", { name: "Support Koona Pin" });
  await expect(plans).toContainText("Test payments");
  // Sync, backups to a folder, the reading themes (NP-124), the badge.
  await expect(plans.getByRole("listitem")).toHaveCount(4);
  // The yearly plan is chosen first; prices drop only ".00".
  await expect(plans.getByRole("radio", { name: /Yearly/ })).toHaveAttribute("aria-checked", "true");
  await expect(plans.getByRole("radio", { name: /Yearly/ })).toContainText("$9.99 a year");
  await expect(plans.getByRole("radio", { name: /Yearly/ })).toContainText("Save 44%");
  await expect(plans.getByRole("radio", { name: /Monthly/ })).toContainText("$1.49 a month");
  // The one-time purchase, under the two subscriptions.
  await expect(plans.getByRole("radio", { name: /One-time/ })).toContainText("$29.99 once");
  await expect(plans.getByRole("radio", { name: /One-time/ })).toContainText("Best value");
  await plans.getByRole("radio", { name: /Monthly/ }).click();
  await expect(plans.getByRole("radio", { name: /Monthly/ })).toHaveAttribute("aria-checked", "true");
  // «Continue» opens the payment in the browser; the dialog waits and sees it paid by itself.
  await plans.getByRole("button", { name: "Continue" }).click();
  const waiting = page.getByRole("dialog", { name: "Finish in your browser" });
  await expect(waiting.getByRole("status")).toHaveText("Waiting for the payment…");
  await expect(page.getByRole("dialog", { name: "Thank you for supporting Koona Pin" })).toContainText("anna@example.com", { timeout: 15_000 });
  await page.getByRole("button", { name: "Done" }).click();
  // The row becomes the badge; it opens the plan and the perks, apart from Settings.
  await expect(row).toHaveAttribute("data-plan-row", "supporter");
  await row.click();
  const plan = page.getByRole("dialog", { name: "Supporter" });
  await expect(plan.locator("[data-plan-dialog]")).toHaveAttribute("data-plan-dialog", "active");
  await expect(plan).toContainText("anna@example.com");
  await expect(plan).toContainText("Renews on");
  // Every perk works already: sync (tests/ui/sync.spec.ts), backups to a folder, the reading themes and the badge.
  await expect(plan.getByText("Soon")).toHaveCount(0);
  await expect(plan.getByRole("listitem")).toHaveCount(4);
  await expect(plan.getByRole("button", { name: "Set up…" })).toBeVisible();
  await expect(plan.getByRole("button", { name: "Choose folder…" })).toBeVisible();
  // The badge is a perk: turned off, the row keeps a plain heart and still opens the dialog.
  const badge = plan.getByRole("switch", { name: "Supporter badge" });
  await expect(badge).toHaveAttribute("aria-checked", "true");
  await badge.click();
  await expect(badge).toHaveAttribute("aria-checked", "false");
  expect(await page.evaluate(() => localStorage.getItem("koonapin.supporterBadge"))).toBe("off");
  await plan.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(row).toHaveAttribute("data-plan-row", "free");
  // Another computer: «I'm already a Supporter» in the dialog, the email, then the code.
  await row.click();
  await page.getByRole("dialog", { name: "Support Koona Pin" }).getByRole("button", { name: "I'm already a Supporter" }).click();
  const signIn = page.getByRole("dialog", { name: "Sign in as a Supporter" });
  await signIn.getByLabel("Email").fill("anna@example.com");
  await signIn.getByRole("button", { name: "Send code" }).click();
  const code = page.getByRole("dialog", { name: "Check your email" });
  await expect(code).toContainText("We sent a 6-digit code to anna@example.com.");
  await code.getByLabel("Code").fill("000000");
  await code.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(code).toContainText("This code didn't work.");
  await code.getByLabel("Code").fill("482913");
  await code.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(row).toHaveAttribute("data-plan-row", "supporter");
});

test("Supporter: the dialog of the plan says when it does not renew, a payment failed, or it could not be checked, at one height (NP-066)", async ({ page }) => {
  const heights: number[] = [];
  for (const [kind, state, text] of [
    ["supporter", "active", "Renews on"],
    ["canceling", "canceling", "Doesn't renew · Supporter until"],
    ["past_due", "past_due", "The renewal didn't go through — update the card"],
    ["offline", "unchecked", "Couldn't check the plan — it stays on until"],
    // Supporter's one-time purchase: no end, nothing to manage, unless a subscription still renews too.
    ["lifetime", "active", "One-time purchase · no renewal, no end date"],
    ["lifetime_renewing", "active", "Your subscription still renews — cancel it in Manage"],
  ] as const) {
    await page.evaluate((k) => localStorage.setItem("koonapin.demo.supporter", k), kind);
    await page.reload();
    await page.locator("[data-plan-row]").click();
    const plan = page.getByRole("dialog", { name: "Supporter" });
    await expect(plan.locator("[data-plan-dialog]")).toHaveAttribute("data-plan-dialog", state);
    await expect(plan).toContainText(text);
    if (kind.startsWith("lifetime")) {
      await expect(plan).toContainText("Supporter · one-time purchase");
      await expect(plan).not.toContainText("Supporter until");
      await expect(plan.getByRole("button", { name: "Manage ↗" })).toHaveCount(kind === "lifetime" ? 0 : 1);
    }
    heights.push(Math.round((await plan.boundingBox())!.height));
  }
  expect(new Set(heights).size, `heights ${heights.join(", ")}`).toBe(1);
  // «Try again» asks the server and the plan is checked again.
  await page.evaluate(() => localStorage.setItem("koonapin.demo.supporter", "offline"));
  await page.reload();
  await page.locator("[data-plan-row]").click();
  await page.getByRole("dialog", { name: "Supporter" }).getByRole("button", { name: "Try again" }).click();
  await expect(page.locator("[data-plan-dialog]")).toHaveAttribute("data-plan-dialog", "active");
});

test("Supporter: a subscription switches to the one-time purchase from the end of its paid period; a server that does not sell it offers neither (NP-066, sheet 45)", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("koonapin.demo.supporter", "supporter"));
  await page.reload();
  await page.locator("[data-plan-row]").click();
  const plan = page.getByRole("dialog", { name: "Supporter" });
  await expect(plan).toContainText("Supporter · yearly");
  await plan.getByRole("button", { name: "Pay once" }).click();
  const upgrade = page.getByRole("dialog", { name: "Switch to a one-time purchase" });
  await expect(upgrade).toContainText("Pay $29.99 once instead of renewing. Your yearly plan stays until");
  await expect(upgrade).toContainText("the one-time purchase takes over that day.");
  await expect(upgrade).toContainText("$29.99 once");
  await expect(upgrade).toContainText("Supporter then has no end date.");
  // Nothing to choose, and no «I'm already a Supporter»: the account is signed in.
  await expect(upgrade.getByRole("radio")).toHaveCount(0);
  await expect(upgrade.getByRole("button", { name: "I'm already a Supporter" })).toHaveCount(0);
  await upgrade.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("dialog", { name: "Thank you for supporting Koona Pin" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Done" }).click();
  await page.locator("[data-plan-row]").click();
  await expect(page.getByRole("dialog", { name: "Supporter" })).toContainText("Supporter · one-time purchase");
  await expect(page.getByRole("dialog", { name: "Supporter" })).toContainText("One-time purchase · no renewal, no end date");
  // The one-time purchase and a plan that does not renew offer no switch.
  await expect(page.getByRole("dialog", { name: "Supporter" }).getByRole("button", { name: "Pay once" })).toHaveCount(0);

  // A server that does not sell the one-time purchase offers neither the card nor the switch.
  await page.evaluate(() => {
    localStorage.setItem("koonapin.demo.supporter", "free");
    localStorage.setItem("koonapin.demo.lifetime", "off");
  });
  await page.reload();
  await page.locator("[data-plan-row]").click();
  const plans = page.getByRole("dialog", { name: "Support Koona Pin" });
  await expect(plans.getByRole("radio", { name: /Yearly/ })).toContainText("$9.99 a year");
  await expect(plans.getByRole("radio", { name: /One-time/ })).toHaveCount(0);
  await expect(plans.getByRole("radio", { name: /Yearly/ })).toHaveAttribute("aria-checked", "true");
  await plans.getByRole("button", { name: "Not now" }).click();
  await page.evaluate(() => localStorage.setItem("koonapin.demo.supporter", "supporter"));
  await page.reload();
  await page.locator("[data-plan-row]").click();
  await expect(plan.getByRole("button", { name: "Manage ↗" })).toBeVisible();
  await expect(plan.getByRole("button", { name: "Pay once" })).toHaveCount(0);
});

test("Supporter: the dialog asks for the plan when it opens and when the window comes back — a change in the portal shows (NP-066)", async ({ page }) => {
  // The server has the plan cancelled at the end of its period, as after «Manage».
  await page.evaluate(() => {
    localStorage.setItem("koonapin.demo.supporter", "supporter");
    localStorage.setItem("koonapin.demo.serverPlan", "canceling");
  });
  await page.reload();
  const row = page.locator("[data-plan-row]");
  await row.click();
  const plan = page.getByRole("dialog", { name: "Supporter" });
  await expect(plan.locator("[data-plan-dialog]")).toHaveAttribute("data-plan-dialog", "canceling");
  await expect(plan).toContainText("Doesn't renew · Supporter until");
  // Cancelled at once, then back to the app: the dialog closes and the row is Free again.
  await page.evaluate(() => {
    localStorage.setItem("koonapin.demo.serverPlan", "none");
    window.dispatchEvent(new Event("focus"));
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(row).toHaveAttribute("data-plan-row", "free");
  await row.click();
  await expect(page.getByRole("dialog", { name: "Support Koona Pin" })).toBeVisible();
});

test("Supporter: backups to a folder — choose, change, stop, and a folder out of reach, at one height (NP-066)", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("koonapin.demo.supporter", "supporter"));
  await page.reload();
  await page.locator("[data-plan-row]").click();
  const plan = page.getByRole("dialog", { name: "Supporter" });
  const row = plan.locator("[data-backup-folder]");
  const heights: number[] = [];
  const height = async () => heights.push(Math.round((await plan.boundingBox())!.height));

  await expect(row).toHaveAttribute("data-backup-folder", "none");
  await expect(row).toContainText("Like Dropbox or Google Drive");
  await height();
  await plan.getByRole("button", { name: "Choose folder…" }).click();
  await expect(row).toHaveAttribute("data-backup-folder", "chosen");
  await expect(row).toContainText("D:\\Dropbox\\Koona Pin · last copy today,");
  await expect(row.locator("[title]")).toHaveAttribute("title", "D:\\Dropbox\\Koona Pin");
  await expect(plan.getByRole("button", { name: "Open folder" })).toBeVisible();
  await expect(plan.getByRole("button", { name: "Change…" })).toBeVisible();
  await height();
  await plan.getByRole("button", { name: "Stop copying here" }).click();
  await expect(row).toHaveAttribute("data-backup-folder", "none");

  await page.evaluate(() => localStorage.setItem("koonapin.demo.backupFolder", "unreachable"));
  await page.reload();
  await page.locator("[data-plan-row]").click();
  await expect(row).toHaveAttribute("data-backup-folder", "unreachable");
  await expect(row).toContainText("Can't reach D:\\Dropbox\\Koona Pin");
  await height();
  await plan.getByRole("button", { name: "Choose…", exact: true }).click();
  await expect(row).toHaveAttribute("data-backup-folder", "chosen");
  expect(new Set(heights).size, `heights ${heights.join(", ")}`).toBe(1);
});

test("Supporter: a payment with the email of an existing account signs in only with the code (NP-066)", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("koonapin.demo.supporter", "existing"));
  await page.reload();
  const row = page.locator("[data-plan-row]");
  await row.click();
  const plans = page.getByRole("dialog", { name: "Support Koona Pin" });
  const height = Math.round((await plans.boundingBox())!.height);
  await plans.getByRole("button", { name: "Continue" }).click();
  const paid = page.getByRole("dialog", { name: "Payment received" });
  await expect(paid).toContainText("already has a Koona Pin account", { timeout: 15_000 });
  expect(Math.round((await paid.boundingBox())!.height)).toBe(height);
  await expect(row).toHaveAttribute("data-plan-row", "free");
  // Closed with «Not now», the payment is not forgotten: Support opens on it again.
  await paid.getByRole("button", { name: "Not now" }).click();
  await row.click();
  const again = page.getByRole("dialog", { name: "Payment received" });
  await expect(again).toContainText("already has a Koona Pin account");
  await again.getByRole("button", { name: "Sign in", exact: true }).click();
  const signIn = page.getByRole("dialog", { name: "Sign in as a Supporter" });
  await signIn.getByLabel("Email").fill("anna@example.com");
  await signIn.getByRole("button", { name: "Send code" }).click();
  const code = page.getByRole("dialog", { name: "Check your email" });
  await code.getByLabel("Code").fill("482913");
  await code.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(row).toHaveAttribute("data-plan-row", "supporter");
});

test("Supporter: a one-time purchase bought again says the payment is refunded, never thanks", async ({ page }) => {
  const row = page.locator("[data-plan-row]");
  await page.evaluate(() => {
    localStorage.setItem("koonapin.demo.supporter", "free");
    localStorage.setItem("koonapin.demo.paidAgain", "on");
  });
  await page.reload();
  await row.click();
  const plans = page.getByRole("dialog", { name: "Support Koona Pin" });
  await expect(plans).toContainText("$29.99 once");
  const height = Math.round((await plans.boundingBox())!.height);
  await plans.getByRole("radio", { name: /One-time/ }).click();
  await plans.getByRole("button", { name: "Continue" }).click();
  const done = page.getByRole("dialog", { name: "You already have the one-time purchase" });
  await expect(done).toContainText("The account anna@example.com already has it, so this payment is refunded", { timeout: 15_000 });
  // Never the thanks or «Payment received» first, and the longer text never makes the dialog grow.
  await expect(page.getByRole("dialog", { name: "Thank you for supporting Koona Pin" })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Payment received" })).toHaveCount(0);
  expect(Math.round((await done.boundingBox())!.height)).toBeLessThanOrEqual(height);
});

test("Supporter: a repeat said for an earlier payment never labels a new one", async ({ page }) => {
  const row = page.locator("[data-plan-row]");
  for (const kind of ["free", "later_paid"] as const) {
    await page.evaluate((k) => {
      localStorage.setItem("koonapin.demo.supporter", k);
      localStorage.setItem("koonapin.demo.paidAgain", "stale");
    }, kind);
    await page.reload();
    await row.click();
    const plans = page.getByRole("dialog", { name: "Support Koona Pin" });
    // later_paid: a yearly plan bought elsewhere arrives while the plans show; free: a yearly payment here.
    if (kind === "free") await plans.getByRole("button", { name: "Continue" }).click();
    const thanks = page.getByRole("dialog", { name: "Thank you for supporting Koona Pin" });
    await expect(thanks, kind).toContainText("Supporter is active", { timeout: 15_000 });
    await expect(page.getByRole("dialog", { name: "You already have the one-time purchase" })).toHaveCount(0);
    await page.keyboard.press("Escape");
  }
});

test("Supporter: a payment the app saw first in the background still ends in thanks; what it finds by itself moves an open dialog on (NP-066)", async ({ page }) => {
  for (const [kind, title, click] of [
    ["background", "Thank you for supporting Koona Pin", true],
    // No click: the background's finding arrives as a status event.
    ["later_sign_in", "Payment received", false],
    ["later_paid", "Thank you for supporting Koona Pin", false],
  ] as const) {
    await page.evaluate((k) => localStorage.setItem("koonapin.demo.supporter", k), kind);
    await page.reload();
    await page.locator("[data-plan-row]").click();
    const plans = page.getByRole("dialog", { name: "Support Koona Pin" });
    await expect(plans).toBeVisible();
    if (click) await plans.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("dialog", { name: title })).toBeVisible({ timeout: 15_000 });
    if (kind === "background") {
      await expect(page.getByRole("dialog", { name: title })).toContainText("anna@example.com");
      await expect(page.locator("[data-plan-row]")).toHaveAttribute("data-plan-row", "supporter");
    }
  }
});

test("Supporter: unreachable server keeps chosen plan; signed in without active plan shows Signed in with See plans and Sign out (NP-066)", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("koonapin.demo.supporter", "no_server"));
  await page.reload();
  const row = page.locator("[data-plan-row]");
  await row.click();
  const plans = page.getByRole("dialog", { name: "Support Koona Pin" });
  await plans.getByRole("button", { name: "Continue" }).click();
  await expect(plans.getByRole("alert")).toHaveText("Couldn't reach the Koona Pin server. Check the connection and try again.");
  await expect(plans.getByRole("button", { name: "Try again" })).toBeVisible();

  await page.evaluate(() => localStorage.setItem("koonapin.demo.supporter", "free"));
  await page.reload();
  await row.click();
  const height = await signInAsSupporter(page, "free@example.com");
  const signedIn = page.getByRole("dialog", { name: "Signed in" });
  await expect(signedIn).toContainText("You're signed in as free@example.com, but this account has no active Supporter plan.");
  expect(Math.round((await signedIn.boundingBox())!.height), "one height through the steps").toBe(height);
  await expect(row).toHaveAttribute("data-plan-row", "free");
  // «See plans» goes to buying.
  await signedIn.getByRole("button", { name: "See plans" }).click();
  await expect(page.getByRole("dialog", { name: "Support Koona Pin" })).toBeVisible();
  // From «Signed in» without a plan, Sign out leaves the account.
  await signInAsSupporter(page, "free@example.com");
  await signedIn.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(async () => (await import("/src/services/api.ts")).api.getSupporterStatus().then((s) => s.email))).toBeNull();
});

test("Supporter: signed in while plan is unknown warns before buying, retries on Try again, and auto-closes when found on reopen (NP-066)", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("koonapin.demo.supporter", "free"));
  await page.reload();
  const row = page.locator("[data-plan-row]");
  await row.click();
  await signInAsSupporter(page, "unknown@example.com");
  const signedIn = page.getByRole("dialog", { name: "Signed in" });
  await expect(signedIn).toContainText("but your plan couldn't be checked right now.");
  await expect(signedIn.getByRole("button", { name: "See plans" })).toHaveCount(0);
  // Closed meanwhile: the plans warn before a second purchase, at the dialog's usual height.
  await signedIn.locator("footer").getByRole("button", { name: "Close" }).click();
  await row.click();
  const plans = page.getByRole("dialog", { name: "Support Koona Pin" });
  await expect(plans.getByRole("status")).toHaveText(
    "The plan of unknown@example.com couldn't be checked yet. Already a Supporter? Wait before buying again — the app tries again within the hour. Delete account…",
  );
  const warned = Math.round((await plans.boundingBox())!.height);
  // Once the server has the plan, reopening the plans asks, finds it, and closes without «thank you».
  await plans.getByRole("button", { name: "Not now" }).click();
  await page.evaluate(() => localStorage.setItem("koonapin.demo.serverPlan", "supporter"));
  await row.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(row).toHaveAttribute("data-plan-row", "supporter");

  // Fresh unknown state: notice fits the usual height, and «Try again» finds the plan.
  await page.evaluate(() => {
    localStorage.removeItem("koonapin.demo.serverPlan");
    localStorage.setItem("koonapin.demo.supporter", "free");
  });
  await page.reload();
  await row.click();
  expect(Math.round((await plans.boundingBox())!.height), "the notice fits the usual height").toBe(warned);
  await signInAsSupporter(page, "unknown@example.com");
  await signedIn.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(row).toHaveAttribute("data-plan-row", "supporter");
});
