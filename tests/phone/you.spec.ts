import { test, expect, type Page } from "@playwright/test";
import { FOLD, openPhone, systemBack, topScreen } from "./fixtures";

// "You & sync" (A1) and the phone's Settings (FL3), NP-072b. The demo's Supporter and sync states
// come from `koonapin.demo.supporter` / `koonapin.demo.sync` (src/services/demo.ts).

const SUPPORTER = { "demo.supporter": "supporter", "demo.sync": "on" };

const openYou = async (page: Page) => {
  await topScreen(page).locator("[data-account]").click();
  const sheet = page.locator('[data-sheet-kind="you"]').getByRole("dialog", { name: "You & sync" });
  await expect(sheet).toBeVisible();
  return sheet;
};
/** A shared dialog (components/ui/Dialog.tsx, a modal <dialog>): outside the phone's root, not a sheet. */
const sharedDialog = (page: Page) => page.locator("dialog[open]");

test("a Supporter sees the plan, sync with its devices, and Settings rows with values", async ({ page }) => {
  await openPhone(page, { settings: SUPPORTER });
  const you = await openYou(page);

  const card = you.locator('[data-supporter="plan"]');
  await expect(card).toContainText("Supporter");
  await expect(card).toContainText(/Thank you · yearly plan, renews/);

  const sync = you.locator('[data-sync-card="on"]');
  await expect(sync).toHaveAttribute("data-state", "synced");
  await expect(sync).toContainText("Synced just now");
  await expect(sync).toContainText("3 devices · Home iMac is the main computer");
  await expect(you.getByRole("list", { name: "Devices" }).getByRole("listitem")).toHaveText([/Home iMac/, /Office laptop/, /Studio PC/]);
  await you.getByRole("button", { name: "Sync now" }).click();
  await expect(sync).toContainText("Synced just now");

  await expect(you.getByRole("button", { name: /Appearance/ })).toContainText("Light");
  await expect(you.getByRole("button", { name: /Language/ })).toContainText("English");
  // Layout is the Fold's.
  await expect(you.getByRole("button", { name: /Layout/ })).toHaveCount(0);
  await expect(you.locator(".ys-footer")).toContainText("your library stays on your devices");
});

test("the plan opens its sheet and sync the shared dialog over the sheet; Back closes them in turn", async ({ page }) => {
  await openPhone(page, { settings: SUPPORTER });
  const you = await openYou(page);
  await you.locator('[data-supporter="plan"]').click();
  await expect(page.locator('[data-sheet-kind="plan"]')).toBeVisible();
  expect(await systemBack(page)).toBe(true);
  await expect(page.locator('[data-sheet-kind="plan"]')).toHaveCount(0);
  await expect(you).toBeVisible();

  await you.getByRole("button", { name: /Synced just now/ }).click();
  await expect(sharedDialog(page)).toBeVisible();
  expect(await systemBack(page)).toBe(true);
  await expect(sharedDialog(page)).toHaveCount(0);
  expect(await systemBack(page)).toBe(true);
  await expect(page.locator('[data-sheet-kind="you"]')).toHaveCount(0);
});

test("without a plan: an invitation, sync explained, and the sign-in where the phone sells nothing", async ({ page }) => {
  await openPhone(page, { settings: { "demo.supporter": "free" } });
  const you = await openYou(page);
  // `purchase: "none"`: nothing invites to buy; the card names Supporter and leads to its sheet.
  await expect(you.locator('[data-supporter="free"]')).toContainText("Koona Pin Supporter");
  await expect(you.locator('[data-supporter="free"]')).not.toContainText("Become");
  await expect(you.locator('[data-sync-card="free"]')).toContainText("Sync comes with Supporter");
  await expect(you.getByRole("button", { name: "Learn more" })).toHaveCount(0);
  await you.locator('[data-supporter="free"]').click();
  const supporter = page.locator('[data-sheet-kind="supporter"]');
  await expect(supporter.getByRole("button", { name: "I'm already a Supporter" })).toBeVisible();
  await supporter.getByRole("button", { name: "I'm already a Supporter" }).click();
  await expect(page.locator('[data-sheet-kind="signIn"]')).toContainText("Sign in as a Supporter");
  await expect(sharedDialog(page)).toHaveCount(0);
});

test("a build that sells nothing shows neither Supporter nor sync", async ({ page }) => {
  await openPhone(page);
  const you = await openYou(page);
  await expect(you.locator("[data-supporter]")).toHaveCount(0);
  await expect(you.locator("[data-sync-card]")).toHaveCount(0);
  await expect(you.getByRole("button", { name: /Appearance/ })).toBeVisible();
});

test("a Settings row opens its page over the list; Back walks back to the tab", async ({ page }) => {
  await openPhone(page, { settings: SUPPORTER });
  const you = await openYou(page);
  await you.getByRole("button", { name: /Appearance/ }).click();
  await expect(page.locator('[data-sheet-kind="you"]')).toHaveCount(0);
  await expect(topScreen(page).getByRole("heading", { level: 1 })).toHaveText("Appearance");

  await topScreen(page).getByRole("radio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await topScreen(page).getByRole("radio", { name: "System" }).click();

  expect(await systemBack(page)).toBe(true);
  await expect(topScreen(page).getByRole("heading", { level: 1 })).toHaveText("Settings");
  await expect(topScreen(page).getByRole("button", { name: /Appearance/ })).toContainText("System");
  expect(await systemBack(page)).toBe(true);
  await expect(topScreen(page)).not.toHaveAttribute("data-route");
});

test("Settings lists what a phone has, and its pages work", async ({ page }) => {
  await openPhone(page, { settings: SUPPORTER });
  await openYou(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const list = topScreen(page);
  await expect(list.getByRole("heading", { level: 1 })).toHaveText("Settings");
  // Nothing of the desktop's own.
  await expect(list).not.toContainText("Start with the system");
  await expect(list).not.toContainText("AI assistants");
  await expect(list.getByRole("button", { name: /^Sync/ }).first()).toContainText("Synced just now");

  // Reading: the text size steps, the reader's choice is kept.
  await list.getByRole("button", { name: /Text size/ }).click();
  const reading = topScreen(page);
  await expect(reading.getByRole("heading", { level: 1 })).toHaveText("Reading");
  await expect(reading.locator(".st-stepper-value")).toHaveText("Default · 18 px");
  await reading.getByRole("button", { name: "Larger text" }).click();
  await expect(reading.locator(".st-stepper-value")).toHaveText("Large · 19 px");
  expect(await page.evaluate(() => localStorage.getItem("koonapin.readerSize"))).toBe("19");
  await reading.getByRole("radio", { name: "White" }).click();
  await expect(reading.getByRole("radio", { name: "White" })).toHaveAttribute("aria-checked", "true");
  await reading.getByRole("button", { name: "Back", exact: true }).click();
  await expect(topScreen(page).getByRole("button", { name: /Text size/ })).toContainText("Large");

  // Language: one choice, English now.
  await topScreen(page).getByRole("button", { name: /Language/ }).click();
  await expect(topScreen(page).getByRole("radio", { name: "English", exact: true })).toHaveAttribute("aria-checked", "true");
  await topScreen(page).getByRole("button", { name: "Back", exact: true }).click();

  // Sync: the devices, and the Sync dialog to manage it.
  await topScreen(page).getByRole("button", { name: /^Sync/ }).first().click();
  await expect(topScreen(page).getByRole("heading", { level: 1 })).toHaveText("Sync");
  await expect(topScreen(page)).toContainText("This device");
  await topScreen(page).getByRole("button", { name: "Manage sync", exact: true }).click();
  await expect(sharedDialog(page)).toBeVisible();
  expect(await systemBack(page)).toBe(true);
  await topScreen(page).getByRole("button", { name: "Back", exact: true }).click();

  // Backups and About.
  await topScreen(page).getByRole("button", { name: /Backups/ }).click();
  await expect(topScreen(page).getByRole("button", { name: "Back up now" })).toBeVisible();
  await topScreen(page).getByRole("button", { name: "Back", exact: true }).click();
  await topScreen(page).getByRole("button", { name: /About & licences/ }).click();
  await expect(topScreen(page)).toContainText("Updates come from your app store.");
});

test("on the Fold, Layout moves the controls to the other side, and it stays", async ({ page }) => {
  await openPhone(page, { viewport: FOLD });
  const root = page.locator("[data-phone]");
  await expect(root).toHaveAttribute("data-hand", "right");
  const you = await openYou(page);
  await expect(you.getByRole("button", { name: /Layout/ })).toContainText("Controls on the right");
  await you.getByRole("button", { name: /Layout/ }).click();
  await expect(topScreen(page).getByRole("heading", { level: 1 })).toHaveText("Layout");
  await topScreen(page).getByRole("radio", { name: "Controls on the left" }).click();
  await expect(root).toHaveAttribute("data-hand", "left");

  await page.reload();
  await expect(page.locator("[data-phone]")).toHaveAttribute("data-hand", "left");
});
