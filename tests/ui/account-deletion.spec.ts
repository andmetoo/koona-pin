import { test, expect, type Page } from "@playwright/test";
import { failOnce, openApp } from "../fixtures/app";

// Deleting the account (billing/deletion.rs) on a desktop: from the Supporter dialog and from the
// signed-in step of the sign-in. The preview's code is any six digits but 000000; after one worked,
// the next actions go without a code, as within the server's ten minutes (src/services/demo.ts).

const dialog = (page: Page) => page.locator("dialog[open]");
const step = (page: Page) => dialog(page).locator("[data-delete-step]");
/** The step shown, without the unseen copies that size the dialog. */
const shown = (page: Page) => dialog(page).locator("[data-state-panel]");

async function openDeletion(page: Page, supporter: string) {
  await openApp(page, { settings: { "demo.supporter": supporter, "demo.sync": "on" } });
  await page.locator("[data-plan-row]").click();
  await page.getByRole("dialog", { name: "Supporter" }).getByRole("button", { name: "Delete account…" }).click();
}

async function enterCode(page: Page, code = "482913") {
  const confirm = page.getByRole("dialog", { name: "Confirm with a code" });
  await confirm.getByLabel("Code").fill(code);
  await confirm.getByRole("button", { name: /Delete account|Keep my account/ }).click();
}

test("a Supporter deletes the account at the end of the paid period, then keeps it; one height throughout", async ({ page }) => {
  await openDeletion(page, "supporter");
  const about = page.getByRole("dialog", { name: "Delete account" });
  await expect(about).toContainText("This deletes the Koona Pin account anna@example.com.");
  await expect(about).toContainText("Payments stop at once.");
  await expect(about).toContainText("The paid time left is not refunded");
  await expect(about).toContainText("Kept: your library on this device");
  // A Paddle plan on a desktop: nothing about Google Play.
  await expect(shown(page)).not.toContainText("Google Play");
  const now = about.getByRole("radio", { name: /^Now/ });
  const later = about.getByRole("radio", { name: /At the end of the paid period/ });
  await expect(now).toHaveAttribute("aria-checked", "true");
  await expect(later).toContainText(/On \w+ \d+, \d{4}\. Supporter works until then\./);
  const height = Math.round((await dialog(page).boundingBox())!.height);
  await later.click();
  await about.getByRole("button", { name: "Continue" }).click();

  const confirm = page.getByRole("dialog", { name: "Confirm with a code" });
  await expect(confirm).toContainText(/We sent a code to anna@example\.com\. Enter it to delete your account on \w+ \d+, \d{4}\./);
  expect(Math.round((await dialog(page).boundingBox())!.height)).toBe(height);
  await enterCode(page, "000000");
  await expect(shown(page)).toContainText("This code didn't work. Check it or send a new one.");
  await enterCode(page);

  const scheduled = page.getByRole("dialog", { name: "Deletion scheduled" });
  await expect(scheduled).toContainText(/Your account will be deleted on \w+ \d+, \d{4}\. Supporter works until then; payments are already stopped\./);
  expect(Math.round((await dialog(page).boundingBox())!.height)).toBe(height);
  await scheduled.getByRole("button", { name: "Done" }).click();

  // The plan says it, and the dialog opens on the date with «Keep my account».
  await page.locator("[data-plan-row]").click();
  const plan = page.getByRole("dialog", { name: "Supporter" });
  await expect(plan.getByRole("status")).toHaveText(/^Account will be deleted on \w+ \d+, \d{4}$/);
  await plan.getByRole("button", { name: "Delete account…" }).click();
  await expect(step(page)).toHaveAttribute("data-delete-step", "scheduled");
  // The sign-in is still fresh: kept without another code.
  await page.getByRole("dialog", { name: "Deletion scheduled" }).getByRole("button", { name: "Keep my account" }).click();
  const kept = page.getByRole("dialog", { name: "Account kept" });
  await expect(kept).toContainText(/Your account stays\. Payments stay stopped: Supporter ends on \w+ \d+, \d{4} unless you buy it again\./);
  expect(Math.round((await dialog(page).boundingBox())!.height)).toBe(height);
  await kept.getByRole("button", { name: "Done" }).click();
  await page.locator("[data-plan-row]").click();
  await expect(page.getByRole("dialog", { name: "Supporter" })).not.toContainText("Account will be deleted");
});

test("deleted now: signed out here, sync off, the library stays", async ({ page }) => {
  await openDeletion(page, "supporter");
  const cards = await page.locator("[data-bookmark-id]").count();
  await page.getByRole("dialog", { name: "Delete account" }).getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("dialog", { name: "Confirm with a code" })).toContainText("Enter it to delete your account now.");
  await enterCode(page);
  const done = page.getByRole("dialog", { name: "Account deleted" });
  await expect(done).toContainText("This device is signed out and sync is off here; your library stays on this device.");
  await done.getByRole("button", { name: "Done" }).click();
  await expect(page.locator("[data-plan-row]")).toHaveAttribute("data-plan-row", "free");
  const sync = await page.evaluate(async () => (await (await import("/src/services/api.ts")).api.getSyncStatus()).enabled);
  expect(sync).toBe(false);
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(cards);
});

test("payments not stopped: nothing deleted, Try again; a paid period over leaves only now", async ({ page }) => {
  await openDeletion(page, "supporter");
  await page.getByRole("dialog", { name: "Delete account" }).getByRole("button", { name: "Continue" }).click();
  await failOnce(page, "deleteAccount", "network", "Payments could not be stopped", "payments_not_stopped");
  await enterCode(page);
  const failed = page.getByRole("dialog", { name: "Account not deleted" });
  await expect(failed.getByRole("alert")).toHaveText("Couldn't stop the payments, so nothing was deleted. Try again.");
  await expect(page.locator("[data-plan-row]")).toHaveAttribute("data-plan-row", "supporter");
  // The sign-in is fresh: Try again needs no new code. The period ended meanwhile: back to now only.
  await failOnce(page, "deleteAccount", "invalid_request", "No paid time is left", "no_paid_time");
  await failed.getByRole("button", { name: "Try again" }).click();
  const about = page.getByRole("dialog", { name: "Delete account" });
  await expect(about.getByRole("alert")).toHaveText("No paid time is left, so the account can only be deleted now.");
  await expect(about.getByRole("radio")).toHaveCount(0);
  await about.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("dialog", { name: "Account deleted" })).toBeVisible();
});

test("a sign-in too old asks for a new code; offline says so", async ({ page }) => {
  // A deletion scheduled earlier (another session): «Keep my account» needs a code now.
  await openDeletion(page, "deleting");
  const scheduled = page.getByRole("dialog", { name: "Deletion scheduled" });
  await failOnce(page, "keepAccount", "network", "No connection", "no_connection");
  await scheduled.getByRole("button", { name: "Keep my account" }).click();
  await expect(scheduled.getByRole("alert")).toHaveText(/couldn't be reached|server/i);
  await scheduled.getByRole("button", { name: "Keep my account" }).click();
  const confirm = page.getByRole("dialog", { name: "Confirm with a code" });
  await expect(confirm).toContainText("Enter it to keep your account.");
  await enterCode(page);
  await expect(page.getByRole("dialog", { name: "Account kept" })).toBeVisible();
});

test("signed in without a plan: delete from the signed-in step, nothing about payments or waiting", async ({ page }) => {
  await openApp(page, { settings: { "demo.supporter": "free" } });
  await page.locator("[data-plan-row]").click();
  await page.getByRole("dialog", { name: "Support Koona Pin" }).getByRole("button", { name: "I'm already a Supporter" }).click();
  await page.getByRole("dialog", { name: "Sign in as a Supporter" }).getByLabel("Email").fill("free@example.com");
  await page.getByRole("dialog", { name: "Sign in as a Supporter" }).getByRole("button", { name: "Send code" }).click();
  await page.getByRole("dialog", { name: "Check your email" }).getByLabel("Code").fill("482913");
  await page.getByRole("dialog", { name: "Check your email" }).getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("dialog", { name: "Signed in" }).getByRole("button", { name: "Delete account…" }).click();
  const about = page.getByRole("dialog", { name: "Delete account" });
  await expect(about).toContainText("free@example.com");
  await expect(shown(page)).not.toContainText("Payments stop");
  await expect(shown(page)).not.toContainText("refund");
  await expect(about.getByRole("radio")).toHaveCount(0);
  await about.getByRole("button", { name: "Continue" }).click();
  await enterCode(page);
  await expect(page.getByRole("dialog", { name: "Account deleted" })).toBeVisible();
});
