import { test, expect, type Page } from "@playwright/test";
import { failOnce, openApp } from "../fixtures/app";

// Deleting the account (billing/deletion.rs) on a desktop, the phone's frames D2–D7 in a dialog: from
// the Supporter dialog, the Support dialog of an account without a plan, and the signed-in step of the
// sign-in. The preview's code is any six digits but 000000; after one worked, the next actions go
// without a code, as within the server's ten minutes, and `demo.deletionFresh` "on" starts with a
// fresh sign-in (src/services/demo.ts).

const dialog = (page: Page) => page.locator("dialog[open]");
const step = (page: Page) => dialog(page).locator("[data-delete-step]");
/** The step shown, without the unseen copies that size the dialog. */
const shown = (page: Page) => dialog(page).locator("[data-state-panel]");
const height = async (page: Page) => Math.round((await dialog(page).boundingBox())!.height);
const SCHEDULED = /^Your account will be deleted on \w+ \d+, \d{4}$/;
const red = (page: Page) => shown(page).getByRole("button", { name: "Delete account", exact: true });

async function openDeletion(page: Page, supporter: string, fresh = false) {
  await openApp(page, { settings: { "demo.supporter": supporter, "demo.sync": "on", ...(fresh ? { "demo.deletionFresh": "on" } : {}) } });
  await page.locator("[data-plan-row]").click();
  await page.getByRole("dialog", { name: "Supporter" }).getByRole("button", { name: "Delete account…" }).click();
}

async function enterCode(page: Page, code = "482913") {
  await shown(page).getByLabel("Code").fill(code);
  await shown(page).getByRole("button", { name: /^(Continue|Keep my account)$/ }).click();
}

test("a Supporter signs in by code, chooses the end of the paid period, confirms with the red button, then keeps the account; one height", async ({ page }) => {
  await openDeletion(page, "supporter");
  const about = page.getByRole("dialog", { name: "Delete your account?" });
  for (const text of ["Your account", "anna@example.com", "Supporter and purchases", "Your devices stop syncing", "Your library", "On this computer and your other devices", "Payment records"])
    await expect(shown(page)).toContainText(text);
  await expect(shown(page)).toContainText("Payments stop now. Time already paid for is not refunded, except as the refund policy allows.");
  await expect(shown(page)).not.toContainText("We cancel your Google Play subscription");
  const first = await height(page);
  // The sign-in here is too old: a code first.
  await about.getByRole("button", { name: "Continue" }).click();
  const code = page.getByRole("dialog", { name: "Check your email" });
  await expect(code).toContainText("We sent a 6-digit code to anna@example.com. Enter it to continue.");
  expect(await height(page)).toBe(first);
  await enterCode(page, "000000");
  await expect(shown(page)).toContainText("This code didn't work. Check it or send a new one.");
  await enterCode(page);

  const when = page.getByRole("dialog", { name: "When should we delete it?" });
  await expect(when).toContainText(/You have Supporter until \w+ \d+, \d{4}\./);
  await expect(when.getByRole("radio", { name: /At the end of the paid period/ })).toHaveAttribute("aria-checked", "true");
  await expect(shown(page)).toContainText("Either way, payments stop now and nothing more is charged.");
  expect(await height(page)).toBe(first);
  // Arrow keys move the choice; the chosen radio is the group's one Tab stop.
  await when.getByRole("radio", { name: /At the end of the paid period/ }).focus();
  await page.keyboard.press("ArrowUp");
  await expect(when.getByRole("radio", { name: /^Delete now/ })).toHaveAttribute("aria-checked", "true");
  await expect(when.getByRole("radio", { name: /^Delete now/ })).toBeFocused();
  await expect(when.getByRole("radio", { name: /At the end of the paid period/ })).toHaveAttribute("tabindex", "-1");
  await page.keyboard.press("ArrowDown");
  await expect(when.getByRole("radio", { name: /At the end of the paid period/ })).toHaveAttribute("aria-checked", "true");
  await when.getByRole("button", { name: "Continue" }).click();

  const confirm = page.getByRole("dialog", { name: "Confirm deletion" });
  await expect(confirm).toContainText(/Your account will be deleted on \w+ \d+, \d{4}\. Supporter works until then\./);
  await expect(red(page)).toHaveClass(/!bg-danger/);
  expect(await height(page)).toBe(first);
  await red(page).click();

  const scheduled = page.getByRole("dialog", { name: SCHEDULED });
  await expect(shown(page)).toContainText("Supporter works until then.");
  await expect(shown(page)).toContainText(/Ends on \w+ \d+, \d{4}/);
  expect(await height(page)).toBe(first);
  await scheduled.getByRole("button", { name: "Done" }).click();

  // The plan says it, and the dialog opens on the date with «Keep my account».
  await page.locator("[data-plan-row]").click();
  const plan = page.getByRole("dialog", { name: "Supporter" });
  await expect(plan.getByRole("status")).toHaveText(/^Account will be deleted on \w+ \d+, \d{4}$/);
  await plan.getByRole("button", { name: "Delete account…" }).click();
  await expect(step(page)).toHaveAttribute("data-delete-step", "scheduled");
  // The sign-in is still fresh: kept without another code.
  await page.getByRole("dialog", { name: SCHEDULED }).getByRole("button", { name: "Keep my account" }).click();
  const kept = page.getByRole("dialog", { name: "Your account stays" });
  await expect(kept).toContainText(/Payments stay stopped: Supporter ends on \w+ \d+, \d{4} unless you buy it again\./);
  await kept.getByRole("button", { name: "Done" }).click();
  await page.locator("[data-plan-row]").click();
  await expect(page.getByRole("dialog", { name: "Supporter" })).not.toContainText("Account will be deleted");
});

test("a fresh sign-in skips the code; deleted now only from the red button: signed out here, sync off, the library stays", async ({ page }) => {
  await openDeletion(page, "supporter", true);
  const cards = await page.locator("[data-bookmark-id]").count();
  await page.getByRole("dialog", { name: "Delete your account?" }).getByRole("button", { name: "Continue" }).click();
  const when = page.getByRole("dialog", { name: "When should we delete it?" });
  await when.getByRole("radio", { name: /^Delete now/ }).click();
  await when.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("dialog", { name: "Confirm deletion" })).toContainText("Your account will be deleted now. This can't be undone.");
  await red(page).click();
  const done = page.getByRole("dialog", { name: "Your account is deleted" });
  await expect(done).toContainText("Your library stays on this computer and your other devices. You are signed out, and sync is off on this device.");
  await done.getByRole("button", { name: "Done" }).click();
  await expect(page.locator("[data-plan-row]")).toHaveAttribute("data-plan-row", "free");
  const sync = await page.evaluate(async () => (await (await import("/src/services/api.ts")).api.getSyncStatus()).enabled);
  expect(sync).toBe(false);
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(cards);
});

test("refusals: payments not stopped, a payment still processing, a paid period over — nothing deleted, and never without the red button", async ({ page }) => {
  await openDeletion(page, "supporter", true);
  await page.getByRole("dialog", { name: "Delete your account?" }).getByRole("button", { name: "Continue" }).click();
  await page.getByRole("dialog", { name: "When should we delete it?" }).getByRole("button", { name: "Continue" }).click();
  await failOnce(page, "deleteAccount", "network", "Payments could not be stopped", "payments_not_stopped");
  await red(page).click();
  const failed = page.getByRole("dialog", { name: "Could not stop payments" });
  await expect(failed.getByRole("alert")).toHaveText("Nothing was deleted, and your account stays as it was. Check your connection and try again.");
  await failOnce(page, "deleteAccount", "network", "A payment is still being processed", "payment_pending");
  await failed.getByRole("button", { name: "Try again" }).click();
  const pending = page.getByRole("dialog", { name: "Account not deleted" });
  await expect(pending.getByRole("alert")).toHaveText("A payment is still being processed. Try again later.");
  await expect(page.locator("[data-plan-row]")).toHaveAttribute("data-plan-row", "supporter");
  // The period ended meanwhile: deleting now is asked again, with its own red button.
  await failOnce(page, "deleteAccount", "invalid_request", "No paid time is left", "no_paid_time");
  await pending.getByRole("button", { name: "Try again" }).click();
  const confirm = page.getByRole("dialog", { name: "Confirm deletion" });
  await expect(confirm.getByRole("alert")).toHaveText("No paid time is left, so the account can only be deleted now.");
  await expect(confirm).toContainText("Your account will be deleted now. This can't be undone.");
  await expect(page.locator("[data-plan-row]")).toHaveAttribute("data-plan-row", "supporter");
  await red(page).click();
  await expect(page.getByRole("dialog", { name: "Your account is deleted" })).toBeVisible();
});

test("an answer that did not come: unknown, never «nothing was deleted»; Check again finds the account still there, or gone", async ({ page }) => {
  await openDeletion(page, "supporter", true);
  await page.getByRole("dialog", { name: "Delete your account?" }).getByRole("button", { name: "Continue" }).click();
  await page.getByRole("dialog", { name: "When should we delete it?" }).getByRole("radio", { name: /^Delete now/ }).click();
  await page.getByRole("dialog", { name: "When should we delete it?" }).getByRole("button", { name: "Continue" }).click();
  await failOnce(page, "deleteAccount", "network", "operation timed out", "deletion_unknown");
  await red(page).click();
  const unknown = page.getByRole("dialog", { name: "We couldn't confirm the deletion" });
  await expect(unknown).toContainText("we don't know yet whether your account was deleted");
  await expect(shown(page)).not.toContainText("Nothing was deleted");
  await unknown.getByRole("button", { name: "Check again" }).click();
  const confirm = page.getByRole("dialog", { name: "Confirm deletion" });
  await expect(confirm.getByRole("alert")).toHaveText("Your account is still there. Nothing was deleted.");
  // Again, and this time the server deleted it before the answer was lost.
  await failOnce(page, "deleteAccount", "network", "operation timed out", "deletion_unknown");
  await red(page).click();
  await page.evaluate(async () => void (await (await import("/src/services/api.ts")).api.signOutSupporter()));
  await page.getByRole("dialog", { name: "We couldn't confirm the deletion" }).getByRole("button", { name: "Check again" }).click();
  await expect(page.getByRole("dialog", { name: "Your account is deleted" })).toBeVisible();
});

test("the review account hears at once that it is not deleted; no code is sent", async ({ page }) => {
  await openDeletion(page, "supporter");
  await failOnce(page, "getAccountDeletion", "invalid_request", "The review account is not deleted", "review_account");
  const about = page.getByRole("dialog", { name: "Delete your account?" });
  await about.getByRole("button", { name: "Continue" }).click();
  await expect(about.getByRole("alert")).toHaveText("This account is used for app review and can't be deleted.");
  await expect(step(page)).toHaveAttribute("data-delete-step", "about");
});

test("a sign-in too old at the red button sends a new code by itself", async ({ page }) => {
  await openDeletion(page, "supporter", true);
  await page.getByRole("dialog", { name: "Delete your account?" }).getByRole("button", { name: "Continue" }).click();
  await page.getByRole("dialog", { name: "When should we delete it?" }).getByRole("button", { name: "Continue" }).click();
  await failOnce(page, "deleteAccount", "invalid_request", "The sign-in is too old", "fresh_sign_in");
  await red(page).click();
  const code = page.getByRole("dialog", { name: "Check your email" });
  await expect(code).toContainText(/Send again in 0:\d\d/);
  await enterCode(page);
  // After the code: the choice and the red button again, never a deletion by itself.
  await expect(page.getByRole("dialog", { name: "When should we delete it?" })).toBeVisible();
});

test("scheduled earlier: Keep needs a code when the sign-in is old; offline says so; «Delete now instead» confirms with the red button", async ({ page }) => {
  await openDeletion(page, "deleting");
  const scheduled = page.getByRole("dialog", { name: SCHEDULED });
  await failOnce(page, "keepAccount", "network", "No connection", "no_connection");
  await scheduled.getByRole("button", { name: "Keep my account" }).click();
  await expect(scheduled.getByRole("alert")).toHaveText("Couldn't reach the Koona Pin server. Check the connection and try again.");
  await scheduled.getByRole("button", { name: "Keep my account" }).click();
  await expect(page.getByRole("dialog", { name: "Keep your account" })).toContainText("We sent a 6-digit code to anna@example.com. Enter it to keep your account.");
  await shown(page).getByRole("button", { name: "Back" }).click();
  await scheduled.getByRole("button", { name: "Delete now instead" }).click();
  await enterCode(page);
  await expect(page.getByRole("dialog", { name: "Confirm deletion" })).toContainText("Your account will be deleted now.");
  await red(page).click();
  await expect(page.getByRole("dialog", { name: "Your account is deleted" })).toBeVisible();
});

test("signed in without a plan: the Support dialog shows the account and «Delete account…»; no payments, no choice of when", async ({ page }) => {
  await openApp(page, { settings: { "demo.supporter": "free" } });
  await page.locator("[data-plan-row]").click();
  await expect(page.getByRole("dialog", { name: "Support Koona Pin" }).locator("[data-account-line]")).toHaveCount(0);
  await page.getByRole("dialog", { name: "Support Koona Pin" }).getByRole("button", { name: "I'm already a Supporter" }).click();
  await page.getByRole("dialog", { name: "Sign in as a Supporter" }).getByLabel("Email").fill("free@example.com");
  await page.getByRole("dialog", { name: "Sign in as a Supporter" }).getByRole("button", { name: "Send code" }).click();
  await page.getByRole("dialog", { name: "Check your email" }).getByLabel("Code").fill("482913");
  await page.getByRole("dialog", { name: "Check your email" }).getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("dialog", { name: "Signed in" }).getByRole("button", { name: "Close" }).first().click();
  await page.locator("[data-plan-row]").click();
  const support = page.getByRole("dialog", { name: "Support Koona Pin" });
  await expect(shown(page).locator("[data-account-line]")).toContainText("Signed in as free@example.com");
  await support.getByRole("button", { name: "Delete account…" }).click();
  const about = page.getByRole("dialog", { name: "Delete your account?" });
  await expect(shown(page)).toContainText("free@example.com");
  await expect(shown(page)).not.toContainText("Payments stop");
  await about.getByRole("button", { name: "Continue" }).click();
  await enterCode(page);
  await expect(page.getByRole("dialog", { name: "Confirm deletion" })).toContainText("deleted now");
  await red(page).click();
  await expect(page.getByRole("dialog", { name: "Your account is deleted" })).toBeVisible();
});
