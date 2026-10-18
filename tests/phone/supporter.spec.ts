import { test, expect, type Page } from "@playwright/test";
import { openPhone, systemBack, topScreen } from "./fixtures";

// Supporter on a phone (NP-072b): the phone's own sheets for Supporter, the sign-in and the plan.
// The Play build sells nothing until NP-154 (`purchase: "none"`, the fixture's default); the site's
// APK sells through Paddle (`purchase: "paddle"`). The demo's states: src/services/demo.ts.

const FREE = { "demo.supporter": "free" };
const SUPPORTER = { "demo.supporter": "supporter", "demo.sync": "on" };
const PADDLE = { purchase: "paddle" };

const sheet = (page: Page, kind: string) => page.locator(`[data-sheet-kind="${kind}"]:not([data-leaving])`);
/** A shared dialog (components/ui/Dialog.tsx): the desktop's, not a sheet. */
const sharedDialog = (page: Page) => page.locator("dialog[open]");

const openYou = async (page: Page) => {
  await topScreen(page).locator("[data-account]").click();
  const you = sheet(page, "you");
  await expect(you).toBeVisible();
  return you;
};

test("where the phone sells nothing, Supporter shows the perks on a phone and the sign-in, and no prices", async ({ page }) => {
  await openPhone(page, { settings: FREE });
  const you = await openYou(page);
  await you.locator('[data-supporter="free"]').click();
  const supporter = sheet(page, "supporter");
  await expect(supporter.getByRole("dialog", { name: "Koona Pin Supporter" })).toBeVisible();
  await expect(supporter).toContainText("Sync with your computers");
  await expect(supporter).toContainText("Paper and Sepia");
  await expect(supporter).toContainText("The Supporter heart");
  await expect(supporter).toContainText("Koona Pin stays free");
  // Nothing of the desktop's, nothing to buy, nothing about where to buy.
  for (const text of [/\$/, /€/, /Continue/, /Paddle/, /folder/i, /browser/i, /assistant/i, /computer you/i, /koona\.app/]) await expect(supporter).not.toContainText(text);
  await expect(supporter.getByRole("radio")).toHaveCount(0);
  await expect(sharedDialog(page)).toHaveCount(0);

  // Back closes it, the You sheet stays.
  expect(await systemBack(page)).toBe(true);
  await expect(sheet(page, "supporter")).toHaveCount(0);
  await expect(you).toBeVisible();
});

test("the sign-in sheet: the email, its errors, the code, and the plan on the phone", async ({ page }) => {
  await openPhone(page, { settings: FREE });
  const you = await openYou(page);
  await you.locator('[data-supporter="free"]').click();
  await sheet(page, "supporter").getByRole("button", { name: "I'm already a Supporter" }).click();

  const signIn = sheet(page, "signIn");
  await expect(signIn.getByRole("dialog", { name: "Sign in as a Supporter" })).toBeVisible();
  await expect(sheet(page, "supporter")).toHaveCount(0);
  const email = signIn.getByLabel("Email");
  await expect(email).toBeFocused();
  const send = signIn.getByRole("button", { name: "Send code" });
  await expect(send).toBeDisabled();
  await email.fill("not an email");
  await send.click();
  await expect(signIn.getByRole("alert")).toContainText("look like an email address");
  await expect(email).toHaveAttribute("aria-invalid", "true");

  await email.fill("anna@example.com");
  await email.press("Enter");
  await expect(signIn.getByRole("dialog", { name: "Check your email" })).toBeVisible();
  await expect(signIn).toContainText("anna@example.com");
  await expect(signIn).toContainText(/Send again in 0:5\d/);
  const code = signIn.getByLabel("Code");
  await expect(code).toHaveAttribute("inputmode", "numeric");
  await expect(code).toHaveAttribute("autocomplete", "one-time-code");
  const signInButton = signIn.getByRole("button", { name: "Sign in", exact: true });
  await code.fill("000 000");
  await signInButton.click();
  await expect(signIn.getByRole("alert")).toBeVisible();

  // Back to the email and forward again keeps the address.
  await signIn.getByRole("button", { name: "Back", exact: true }).click();
  await expect(signIn.getByLabel("Email")).toHaveValue("anna@example.com");
  await signIn.getByRole("button", { name: "Send code" }).click();
  await signIn.getByLabel("Code").fill("123456");
  await signIn.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(sheet(page, "signIn")).toHaveCount(0);
  await expect(you.locator('[data-supporter="plan"]')).toContainText(/Thank you · yearly plan, renews/);
});

test("signed in to an account with no plan: what it is, sign out, and no plans to see where nothing is sold", async ({ page }) => {
  await openPhone(page, { settings: FREE });
  const you = await openYou(page);
  await you.locator('[data-supporter="free"]').click();
  await sheet(page, "supporter").getByRole("button", { name: "I'm already a Supporter" }).click();
  const signIn = sheet(page, "signIn");
  await signIn.getByLabel("Email").fill("free@example.com");
  await signIn.getByRole("button", { name: "Send code" }).click();
  await signIn.getByLabel("Code").fill("123456");
  await signIn.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(signIn.getByRole("dialog", { name: "Signed in" })).toBeVisible();
  await expect(signIn).toContainText("has no active Supporter plan");
  await expect(signIn.getByRole("button", { name: "See plans" })).toHaveCount(0);
  await signIn.getByRole("button", { name: "Sign out" }).click();
  await expect(sheet(page, "signIn")).toHaveCount(0);
});

test("the plan sheet: the plan, its state, the perks with the heart's switch, Manage, sign out", async ({ page }) => {
  await openPhone(page, { settings: SUPPORTER });
  const you = await openYou(page);
  await you.locator('[data-supporter="plan"]').click();
  const plan = sheet(page, "plan");
  await expect(plan.getByRole("dialog", { name: "Supporter" })).toBeVisible();
  await expect(plan).toContainText("Supporter · yearly");
  await expect(plan).toContainText("anna@example.com");
  await expect(plan).toContainText(/Renews on/);
  await expect(plan.getByRole("button", { name: /Sync/ })).toContainText("Synced just now");
  await expect(plan.getByRole("button", { name: "Manage" })).toBeVisible();
  // The phone sells nothing: no switch to five years.
  await expect(plan.getByRole("button", { name: "Switch to 5 years" })).toHaveCount(0);
  await expect(plan).not.toContainText(/folder/i);

  const heart = plan.getByRole("switch", { name: "The Supporter heart" });
  await expect(heart).toHaveAttribute("aria-checked", "true");
  await heart.click();
  await expect(heart).toHaveAttribute("aria-checked", "false");
  expect(await page.evaluate(() => localStorage.getItem("koonapin.supporterBadge"))).toBe("off");

  // Sync opens its shared dialog over the sheet; Back closes it, then the sheet.
  await plan.getByRole("button", { name: /Sync/ }).click();
  await expect(sharedDialog(page)).toBeVisible();
  expect(await systemBack(page)).toBe(true);
  await expect(sharedDialog(page)).toHaveCount(0);
  await expect(plan).toBeVisible();

  await plan.getByRole("button", { name: "Sign out" }).click();
  await expect(sheet(page, "plan")).toHaveCount(0);
  await expect(you.locator('[data-supporter="free"]')).toBeVisible();
});

test("a locked reading theme leads to Supporter's sheet", async ({ page }) => {
  await openPhone(page, { settings: FREE });
  await openYou(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await topScreen(page).getByRole("button", { name: /Text size/ }).click();
  await topScreen(page).getByRole("radio", { name: /Paper/ }).click();
  await expect(sheet(page, "supporter").getByRole("dialog", { name: "Koona Pin Supporter" })).toBeVisible();
  await expect(sheet(page, "supporter").getByRole("radio")).toHaveCount(0);
});

test("a build that sells through Paddle: the plans, Continue to the checkout, the wait and thanks", async ({ page }) => {
  await openPhone(page, { settings: FREE, capabilities: PADDLE });
  const you = await openYou(page);
  await expect(you.locator('[data-supporter="free"]')).toContainText("Become a Supporter");
  await you.locator('[data-supporter="free"]').click();
  const supporter = sheet(page, "supporter");
  const plans = supporter.getByRole("radiogroup", { name: "Plan" });
  await expect(plans.getByRole("radio")).toHaveText([/Yearly.*\$20 a year/, /Monthly.*\$2 a month/, /5 years.*\$50 once/]);
  await expect(plans.getByRole("radio", { name: /Yearly/ })).toHaveAttribute("aria-checked", "true");
  await expect(supporter).toContainText("Payment opens in your browser");
  await expect(supporter.getByRole("button", { name: "I'm already a Supporter" })).toBeVisible();

  await plans.getByRole("radio", { name: /5 years/ }).click();
  await expect(plans.getByRole("radio", { name: /5 years/ })).toHaveAttribute("aria-checked", "true");
  await supporter.getByRole("button", { name: "Continue" }).click();
  await expect(supporter.getByRole("dialog", { name: "Finish in your browser" })).toBeVisible();
  await expect(supporter.getByRole("status")).toContainText("Waiting for the payment");
  await expect(supporter.getByRole("button", { name: "Open the page again" })).toBeEnabled();
  // The demo's checkout is paid on the third poll.
  await expect(supporter.getByRole("dialog", { name: "Thank you for supporting Koona Pin" })).toBeVisible({ timeout: 15_000 });
  await expect(supporter).toContainText("anna@example.com");
  await supporter.getByRole("button", { name: "Done" }).click();
  await expect(sheet(page, "supporter")).toHaveCount(0);
  // The checkout was started for the plan chosen: the demo grants five years for five years.
  await expect(you.locator('[data-supporter="plan"]')).toContainText(/5 years, until/);
});

test("a build that sells through Paddle offers the switch to five years on a renewing plan", async ({ page }) => {
  await openPhone(page, { settings: SUPPORTER, capabilities: PADDLE });
  const you = await openYou(page);
  await you.locator('[data-supporter="plan"]').click();
  const plan = sheet(page, "plan");
  await plan.getByRole("button", { name: "Switch to 5 years" }).click();
  await expect(sheet(page, "plan")).toHaveCount(0);
  await expect(sharedDialog(page)).toContainText("Switch to 5 years");
});

test("the sign-in's action stays above the keyboard", async ({ page }) => {
  await openPhone(page, { settings: FREE });
  const you = await openYou(page);
  await you.locator('[data-supporter="free"]').click();
  await sheet(page, "supporter").getByRole("button", { name: "I'm already a Supporter" }).click();
  // Android passes the keyboard in the bottom inset (--safe-bottom): 300 dp of it over the 34.
  await page.evaluate(() => document.documentElement.style.setProperty("--kp-inset-bottom", "334px"));
  const signIn = sheet(page, "signIn");
  await signIn.getByLabel("Email").fill("anna@example.com");
  const send = signIn.getByRole("button", { name: "Send code" });
  await expect(send).toBeVisible();
  await page.waitForTimeout(400);
  const box = (await send.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(852 - 334);
  const field = (await signIn.getByLabel("Email").boundingBox())!;
  expect(field.y).toBeGreaterThan(0);
});
