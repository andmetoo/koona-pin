import { test, expect, type Page } from "@playwright/test";
import { failOnce, openApp } from "../fixtures/app";

// Deleting the account (billing/deletion.rs) on a desktop, the phone's frames D2–D7 in a dialog: from
// the Supporter dialog and from the signed-in step of the sign-in. The preview's code is any six
// digits but 000000; after one worked, the next actions go without a code, as within the server's ten
// minutes (src/services/demo.ts).

const dialog = (page: Page) => page.locator("dialog[open]");
const step = (page: Page) => dialog(page).locator("[data-delete-step]");
/** The step shown, without the unseen copies that size the dialog. */
const shown = (page: Page) => dialog(page).locator("[data-state-panel]");
const height = async (page: Page) => Math.round((await dialog(page).boundingBox())!.height);
const SCHEDULED = /^Your account will be deleted on \w+ \d+, \d{4}$/;

async function openDeletion(page: Page, supporter: string) {
  await openApp(page, { settings: { "demo.supporter": supporter, "demo.sync": "on" } });
  await page.locator("[data-plan-row]").click();
  await page.getByRole("dialog", { name: "Supporter" }).getByRole("button", { name: "Delete account…" }).click();
}

async function enterCode(page: Page, code = "482913") {
  await shown(page).getByLabel("Code").fill(code);
  await shown(page).getByRole("button", { name: /^(Delete account|Keep my account)$/ }).click();
}

test("a Supporter deletes the account at the end of the paid period, then keeps it; one height throughout", async ({ page }) => {
  await openDeletion(page, "supporter");
  const about = page.getByRole("dialog", { name: "Delete your account?" });
  for (const text of ["Your account", "anna@example.com", "Supporter and purchases", "Your devices stop syncing", "Your library", "On this computer and your other devices", "Payment records"])
    await expect(shown(page)).toContainText(text);
  await expect(shown(page)).toContainText("Payments stop now. Time already paid for is not refunded, except as the refund policy allows.");
  // A desktop build sells no Google Play subscription to cancel.
  await expect(shown(page)).not.toContainText("We cancel your Google Play subscription");
  const first = await height(page);
  await about.getByRole("button", { name: "Continue" }).click();

  const when = page.getByRole("dialog", { name: "When should we delete it?" });
  await expect(when).toContainText(/You have Supporter until \w+ \d+, \d{4}\./);
  // The end of the paid period is chosen first (D3).
  await expect(when.getByRole("radio", { name: /At the end of the paid period/ })).toHaveAttribute("aria-checked", "true");
  await expect(when.getByRole("radio", { name: /^Delete now/ })).toHaveAttribute("aria-checked", "false");
  await expect(shown(page)).toContainText("Either way, payments stop now and nothing more is charged.");
  expect(await height(page)).toBe(first);
  await when.getByRole("button", { name: "Continue" }).click();

  const confirm = page.getByRole("dialog", { name: "Confirm deletion" });
  await expect(confirm).toContainText("We sent a 6-digit code to anna@example.com. Enter it to delete your account.");
  expect(await height(page)).toBe(first);
  await enterCode(page, "000000");
  await expect(shown(page)).toContainText("This code didn't work. Check it or send a new one.");
  await enterCode(page);

  const scheduled = page.getByRole("dialog", { name: SCHEDULED });
  await expect(shown(page)).toContainText("Supporter works until then.");
  await expect(shown(page)).toContainText(/Ends on \w+ \d+, \d{4}/);
  await expect(shown(page)).toContainText("Payments are stopped, so nothing more is charged.");
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
  expect(await height(page)).toBe(first);
  await kept.getByRole("button", { name: "Done" }).click();
  await page.locator("[data-plan-row]").click();
  await expect(page.getByRole("dialog", { name: "Supporter" })).not.toContainText("Account will be deleted");
});

test("deleted now: signed out here, sync off, the library stays", async ({ page }) => {
  await openDeletion(page, "supporter");
  const cards = await page.locator("[data-bookmark-id]").count();
  await page.getByRole("dialog", { name: "Delete your account?" }).getByRole("button", { name: "Continue" }).click();
  const when = page.getByRole("dialog", { name: "When should we delete it?" });
  await when.getByRole("radio", { name: /^Delete now/ }).click();
  await when.getByRole("button", { name: "Continue" }).click();
  await enterCode(page);
  const done = page.getByRole("dialog", { name: "Your account is deleted" });
  await expect(done).toContainText("Your library stays on this computer and your other devices. You are signed out, and sync is off on this device.");
  await done.getByRole("button", { name: "Done" }).click();
  await expect(page.locator("[data-plan-row]")).toHaveAttribute("data-plan-row", "free");
  const sync = await page.evaluate(async () => (await (await import("/src/services/api.ts")).api.getSyncStatus()).enabled);
  expect(sync).toBe(false);
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(cards);
});

test("payments not stopped: nothing deleted, Try again; a paid period over leaves only now", async ({ page }) => {
  await openDeletion(page, "supporter");
  await page.getByRole("dialog", { name: "Delete your account?" }).getByRole("button", { name: "Continue" }).click();
  await page.getByRole("dialog", { name: "When should we delete it?" }).getByRole("button", { name: "Continue" }).click();
  await failOnce(page, "deleteAccount", "network", "Payments could not be stopped", "payments_not_stopped");
  await enterCode(page);
  const failed = page.getByRole("dialog", { name: "Could not stop payments" });
  await expect(failed.getByRole("alert")).toHaveText("Nothing was deleted, and your account stays as it was. Check your connection and try again.");
  await expect(page.locator("[data-plan-row]")).toHaveAttribute("data-plan-row", "supporter");
  // The sign-in is fresh: Try again needs no new code. The period ended meanwhile: only now is left.
  await failOnce(page, "deleteAccount", "invalid_request", "No paid time is left", "no_paid_time");
  await failed.getByRole("button", { name: "Try again" }).click();
  const about = page.getByRole("dialog", { name: "Delete your account?" });
  await expect(about.getByRole("alert")).toHaveText("No paid time is left, so the account can only be deleted now.");
  // No paid time: no choice of when (D2 → D4), and the fresh sign-in deletes at once.
  await about.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("dialog", { name: "Your account is deleted" })).toBeVisible();
});

test("a sign-in too old asks for a new code; offline says so", async ({ page }) => {
  // A deletion scheduled earlier (another session): «Keep my account» needs a code now.
  await openDeletion(page, "deleting");
  const scheduled = page.getByRole("dialog", { name: SCHEDULED });
  await failOnce(page, "keepAccount", "network", "No connection", "no_connection");
  await scheduled.getByRole("button", { name: "Keep my account" }).click();
  await expect(scheduled.getByRole("alert")).toHaveText("Couldn't reach the Koona Pin server. Check the connection and try again.");
  await scheduled.getByRole("button", { name: "Keep my account" }).click();
  const confirm = page.getByRole("dialog", { name: "Keep your account" });
  await expect(confirm).toContainText("We sent a 6-digit code to anna@example.com. Enter it to keep your account.");
  await enterCode(page);
  await expect(page.getByRole("dialog", { name: "Your account stays" })).toBeVisible();
});

test("signed in without a plan: delete from the signed-in step, nothing about payments, no choice of when", async ({ page }) => {
  await openApp(page, { settings: { "demo.supporter": "free" } });
  await page.locator("[data-plan-row]").click();
  await page.getByRole("dialog", { name: "Support Koona Pin" }).getByRole("button", { name: "I'm already a Supporter" }).click();
  await page.getByRole("dialog", { name: "Sign in as a Supporter" }).getByLabel("Email").fill("free@example.com");
  await page.getByRole("dialog", { name: "Sign in as a Supporter" }).getByRole("button", { name: "Send code" }).click();
  await page.getByRole("dialog", { name: "Check your email" }).getByLabel("Code").fill("482913");
  await page.getByRole("dialog", { name: "Check your email" }).getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("dialog", { name: "Signed in" }).getByRole("button", { name: "Delete account…" }).click();
  const about = page.getByRole("dialog", { name: "Delete your account?" });
  await expect(shown(page)).toContainText("free@example.com");
  await expect(shown(page)).not.toContainText("Payments stop");
  await about.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("dialog", { name: "Confirm deletion" })).toBeVisible();
  await enterCode(page);
  await expect(page.getByRole("dialog", { name: "Your account is deleted" })).toBeVisible();
});
