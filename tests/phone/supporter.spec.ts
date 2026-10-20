import { test, expect, type Page } from "@playwright/test";
import { openPhone, systemBack, topScreen } from "./fixtures";
import { failOnce } from "../fixtures/app";

// Supporter on a phone (NP-072b): the phone's own sheets for Supporter, the sign-in and the plan.
// A build that sells nothing (`purchase: "none"`, the fixture's default); the site's APK sells
// through Paddle (`purchase: "paddle"`); the Play build through Google Play Billing (`purchase:
// "play"`, NP-154), where `demo.play` is the server's verdict on a purchase and `demo.store` "play"
// makes the preview's plan one paid through Google Play. The demo's states: src/services/demo.ts.

const FREE = { "demo.supporter": "free" };
const SUPPORTER = { "demo.supporter": "supporter", "demo.sync": "on" };
const PADDLE = { purchase: "paddle" };
const PLAY = { purchase: "play" };
const PLAY_PAGE = "https://play.google.com/store/account/subscriptions?sku=supporter&package=app.koona.pin";
/** Nothing on a Play build's sheets says where else Supporter is sold. */
const ELSEWHERE = [/koona\.app/, /Paddle/, /browser/i, /card/i];

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

test("where nothing is sold, the plan sheet links to no Paddle page: a failed renewal says so plainly", async ({ page }) => {
  await openPhone(page, { settings: { "demo.supporter": "past_due", "demo.sync": "on" } });
  const you = await openYou(page);
  await expect(you.locator('[data-supporter="plan"]')).toContainText(/The last payment didn't go through · Supporter until/);
  await you.locator('[data-supporter="plan"]').click();
  const plan = sheet(page, "plan");
  await expect(plan.locator("[data-plan-sheet]")).toHaveAttribute("data-plan-sheet", "past_due");
  await expect(plan.getByRole("status")).toHaveText(/^The last payment didn't go through · Supporter until \w+ \d+, \d{4}$/);
  await expect(plan).toContainText("Your plan is managed where you started it.");
  for (const name of ["Manage", "Update card", "Switch to 5 years"]) await expect(plan.getByRole("button", { name })).toHaveCount(0);
  await expect(plan).not.toContainText(/card|Paddle|browser/i);
  await expect(plan.getByRole("button", { name: "Sign out" })).toBeVisible();
});

test("where nothing is sold, sync's banner for a plan that ends has no Renew", async ({ page }) => {
  await openPhone(page, { settings: { "demo.supporter": "canceling", "demo.sync": "on" } });
  const you = await openYou(page);
  await you.locator('[data-supporter="plan"]').click();
  await sheet(page, "plan").getByRole("button", { name: /Sync/ }).click();
  const banner = sharedDialog(page).locator('[data-sync-banner="plan_ends"]');
  await expect(banner).toContainText("Sync stops on");
  await expect(banner.getByRole("button")).toHaveCount(0);
});

test("a help link that can't open in Sync: the snackbar over the dialog, as it looks at home, and back when it closes (NP-092)", async ({ page }) => {
  await openPhone(page, { settings: { "demo.supporter": "canceling", "demo.sync": "on" } });
  const you = await openYou(page);
  await you.locator('[data-supporter="plan"]').click();
  await sheet(page, "plan").getByRole("button", { name: /Sync/ }).click();
  const dialog = sharedDialog(page);
  await failOnce(page, "openUrl", "internal", "No browser to open the link");
  await dialog.getByRole("button", { name: "Help ↗" }).click();
  const snackbar = dialog.locator(".ph-snackbar").filter({ hasText: "No browser to open the link" });
  await expect(snackbar).toBeVisible();
  // The phone's pill, not a bare box: its styles come with it into the dialog.
  expect(await snackbar.evaluate((el) => getComputedStyle(el).borderRadius)).toBe("999px");
  const onTop = await snackbar.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  });
  expect(onTop).toBe(true);
  // An alert stays until closed: with the dialog gone, it is back in the phone, the same one.
  await snackbar.evaluate((el) => el.setAttribute("data-same", ""));
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("[data-phone] .ph-snackbar[data-same]")).toBeVisible();
});

test("the snackbar over a dialog follows the phone as it changes, and leaves nothing of the phone there once closed (NP-092)", async ({ page }) => {
  await openPhone(page, { settings: { "demo.supporter": "canceling", "demo.sync": "on" } });
  const you = await openYou(page);
  await you.locator('[data-supporter="plan"]').click();
  await sheet(page, "plan").getByRole("button", { name: /Sync/ }).click();
  const dialog = sharedDialog(page);
  await failOnce(page, "openUrl", "internal", "No browser to open the link");
  await dialog.getByRole("button", { name: "Help ↗" }).click();
  const snackbar = dialog.locator(".ph-snackbar");
  await expect(snackbar).toBeVisible();
  // The keyboard comes up: the root lifts and says so; the snackbar in the dialog lifts with it.
  await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>("[data-phone]")!;
    root.style.setProperty("--ph-lift", "240px");
    root.setAttribute("data-keyboard", "");
  });
  const box = dialog.locator(".phone");
  await expect(box).toHaveAttribute("data-keyboard", "");
  expect(await box.evaluate((el) => el.style.getPropertyValue("--ph-lift"))).toBe("240px");
  // Closed while the dialog stays: no second «phone» is left in it.
  await snackbar.getByRole("button", { name: "Close" }).click();
  await expect(snackbar).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".phone, [data-fold], [data-pill], [data-keyboard]")).toHaveCount(0);
});

test("a build that sells through Paddle keeps Renew in sync's banner and Manage in the plan", async ({ page }) => {
  await openPhone(page, { settings: { "demo.supporter": "canceling", "demo.sync": "on" }, capabilities: PADDLE });
  const you = await openYou(page);
  await you.locator('[data-supporter="plan"]').click();
  const plan = sheet(page, "plan");
  await expect(plan.getByRole("button", { name: "Manage" })).toBeVisible();
  await expect(plan).not.toContainText("managed where you started it");
  await plan.getByRole("button", { name: /Sync/ }).click();
  await expect(sharedDialog(page).locator('[data-sync-banner="plan_ends"]').getByRole("button", { name: "Renew…" })).toBeVisible();
});

test("the plan sheet: the plan, its state, the perks with the heart's switch, sign out", async ({ page }) => {
  await openPhone(page, { settings: SUPPORTER });
  const you = await openYou(page);
  await you.locator('[data-supporter="plan"]').click();
  const plan = sheet(page, "plan");
  await expect(plan.getByRole("dialog", { name: "Supporter" })).toBeVisible();
  await expect(plan).toContainText("Supporter · yearly");
  await expect(plan).toContainText("anna@example.com");
  await expect(plan).toContainText(/Renews on/);
  await expect(plan.getByRole("button", { name: /Sync/ })).toContainText("Synced just now");
  // The phone sells nothing: no Paddle portal, no switch to five years.
  await expect(plan.getByRole("button", { name: "Manage" })).toHaveCount(0);
  await expect(plan).toContainText("Your plan is managed where you started it.");
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

// ── The Play build (NP-154) ─────────────────────────────────────────────────

/** The Play build's Supporter sheet, opened from You. */
const openPlay = async (page: Page, settings: Record<string, string> = FREE) => {
  await openPhone(page, { settings, capabilities: PLAY });
  const you = await openYou(page);
  await you.locator('[data-supporter="free"]').click();
  const supporter = sheet(page, "supporter");
  await expect(supporter.getByRole("dialog", { name: "Koona Pin Supporter" })).toBeVisible();
  return { you, supporter };
};

/** The links the preview opens (demo `openUrl` is `window.open`). */
const recordLinks = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { opened: string[] };
    w.opened = [];
    window.open = ((url: string) => void w.opened.push(url)) as typeof window.open;
  });
const opened = (page: Page) => page.evaluate(() => (window as unknown as { opened: string[] }).opened);

test("the Play build: «I'm already a Supporter» first, Google Play's prices with a button each, what renews and how to cancel", async ({ page }) => {
  const { supporter } = await openPlay(page);
  const body = supporter.locator(".ph-sheet-body");
  await expect(body.locator(":scope > *").first()).toHaveText("I'm already a Supporter");
  const plans = supporter.getByRole("list", { name: "Plan" }).getByRole("listitem");
  await expect(plans).toHaveText([/Yearly.*2 months free.*€20\.00 a year.*Subscribe/, /Monthly.*€2\.00 a month.*Subscribe/, /5 years.*Save 50%.*€50\.00 once.*Buy/]);
  for (const name of ["Subscribe · Yearly", "Subscribe · Monthly", "Buy · 5 years"]) await expect(supporter.getByRole("button", { name })).toBeEnabled();
  await expect(supporter.locator("[data-play-terms] p")).toHaveText([
    "Yearly and monthly renew automatically at their price until you cancel. Cancel any time in Google Play.",
    "5 years are paid once and don't renew.",
  ]);
  await expect(supporter.getByRole("radio")).toHaveCount(0);
  for (const text of ELSEWHERE) await expect(supporter).not.toContainText(text);
  await supporter.getByRole("button", { name: "I'm already a Supporter" }).click();
  await expect(sheet(page, "signIn").getByRole("dialog", { name: "Sign in as a Supporter" })).toBeVisible();
});

test("the Play build: bought signed out, the email claims it, the code signs in, thanks, and the plan is managed in Google Play", async ({ page }) => {
  const { you, supporter } = await openPlay(page);
  await supporter.getByRole("button", { name: "Subscribe · Monthly" }).click();
  await expect(supporter.getByRole("dialog", { name: "Where should we send your code?" })).toBeVisible();
  await expect(supporter).toContainText("Google Play has your payment");
  const email = supporter.getByLabel("Email");
  await expect(email).toBeFocused();
  await email.fill("not an email");
  await supporter.getByRole("button", { name: "Send code" }).click();
  await expect(supporter.getByRole("alert")).toContainText("look like an email address");

  // Closed on the way, the purchase waits: the sheet opens on its email again.
  expect(await systemBack(page)).toBe(true);
  await expect(sheet(page, "supporter")).toHaveCount(0);
  await you.locator('[data-supporter="free"]').click();
  await expect(supporter.getByRole("dialog", { name: "Where should we send your code?" })).toBeVisible();

  await supporter.getByLabel("Email").fill("anna@example.com");
  await supporter.getByLabel("Email").press("Enter");
  await expect(supporter.getByRole("dialog", { name: "Check your email" })).toBeVisible();
  await expect(supporter).toContainText("We sent a 6-digit code to anna@example.com. Enter it to sign in and finish the purchase.");
  await expect(supporter).toContainText(/Send again in 0:5\d/);
  await supporter.getByLabel("Code").fill("000 000");
  await supporter.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(supporter.getByRole("alert")).toBeVisible();
  await supporter.getByLabel("Code").fill("123456");
  await supporter.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(supporter.getByRole("dialog", { name: "Thank you for supporting Koona Pin" })).toBeVisible();
  await expect(supporter).toContainText("Supporter is active for anna@example.com.");
  await supporter.getByRole("button", { name: "Done" }).click();
  await expect(sheet(page, "supporter")).toHaveCount(0);

  await expect(you.locator('[data-supporter="plan"]')).toContainText(/Thank you · yearly plan, renews/);
  await you.locator('[data-supporter="plan"]').click();
  const plan = sheet(page, "plan");
  await recordLinks(page);
  await plan.getByRole("button", { name: "Manage in Google Play" }).click();
  expect(await opened(page)).toEqual([PLAY_PAGE]);
  await expect(plan).not.toContainText("managed where you started it");
  for (const text of ELSEWHERE) await expect(plan).not.toContainText(text);
});

test("the Play build: a slow payment waits for Google Play, and the sheet opens on it again", async ({ page }) => {
  const { you, supporter } = await openPlay(page, { ...FREE, "demo.play": "pending" });
  await supporter.getByRole("button", { name: "Subscribe · Yearly" }).click();
  await expect(supporter.getByRole("dialog", { name: "Payment pending" })).toBeVisible();
  await expect(supporter.getByRole("status")).toHaveText("Waiting for Google Play to confirm the payment…");
  await supporter.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(sheet(page, "supporter")).toHaveCount(0);
  await you.locator('[data-supporter="free"]').click();
  await expect(sheet(page, "supporter").getByRole("dialog", { name: "Payment pending" })).toBeVisible();
});

test("the Play build: a Supporter buying again is refunded; another account's purchase asks to sign in to it", async ({ page }) => {
  const { supporter } = await openPlay(page, { ...FREE, "demo.play": "already_supporter" });
  await supporter.getByRole("button", { name: "Buy · 5 years" }).click();
  await expect(supporter.getByRole("dialog", { name: "You already have Supporter" })).toBeVisible();
  await expect(supporter).toContainText("Google Play refunds this purchase.");
  await supporter.getByRole("button", { name: "Done" }).click();
  await expect(sheet(page, "supporter")).toHaveCount(0);

  await page.evaluate(() => localStorage.setItem("koonapin.demo.play", "other_account"));
  const you = sheet(page, "you");
  await you.locator('[data-supporter="free"]').click();
  await sheet(page, "supporter").getByRole("button", { name: "Subscribe · Yearly" }).click();
  const other = sheet(page, "supporter");
  await expect(other.getByRole("dialog", { name: "Bought for another account" })).toBeVisible();
  await expect(other).toContainText("belongs to another Koona Pin account. Sign in with that account's email");
  await other.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(sheet(page, "signIn").getByRole("dialog", { name: "Sign in as a Supporter" })).toBeVisible();
});

test("the Play build: signed out, a Supporter this Google account owns asks to sign in to its account; no code was sent", async ({ page }) => {
  const { supporter } = await openPlay(page, { ...FREE, "demo.play": "owned" });
  await supporter.getByRole("button", { name: "Subscribe · Yearly" }).click();
  await expect(supporter.getByRole("dialog", { name: "Sign in to use it" })).toBeVisible();
  await expect(supporter).toContainText("belongs to a Koona Pin account. Sign in with that account's email");
  await expect(supporter.getByLabel("Code")).toHaveCount(0);
  await supporter.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(sheet(page, "signIn").getByRole("dialog", { name: "Sign in as a Supporter" })).toBeVisible();
});

test("the Play build: a subscription on hold or paused is fixed in Google Play, never bought again", async ({ page }) => {
  // Play says so of what this Google account owns as the sheet opens: no plans to buy.
  const { supporter } = await openPlay(page, { ...FREE, "demo.playSuspended": "on" });
  await expect(supporter).toContainText("Your Supporter subscription is on hold or paused in Google Play.");
  await expect(supporter.getByRole("button", { name: /Subscribe|Buy/ })).toHaveCount(0);
  await recordLinks(page);
  await supporter.getByRole("button", { name: "Fix payment in Google Play" }).click();
  expect(await opened(page)).toEqual([PLAY_PAGE]);
  for (const text of ELSEWHERE) await expect(supporter).not.toContainText(text);
});

test("the Play build: the server finds the account's own subscription on hold after a purchase", async ({ page }) => {
  const { supporter } = await openPlay(page, { ...FREE, "demo.play": "suspended" });
  await supporter.getByRole("button", { name: "Subscribe · Monthly" }).click();
  await expect(supporter.getByRole("button", { name: "Fix payment in Google Play" })).toBeVisible();
  await expect(supporter).toContainText("Fix the payment or resume it there");
  await expect(supporter.getByRole("button", { name: /Subscribe|Buy/ })).toHaveCount(0);
});

test("the Play build: a cancelled purchase is back on the plans quietly; a failure says so with Try again", async ({ page }) => {
  const { supporter } = await openPlay(page, { ...FREE, "demo.play": "canceled" });
  await supporter.getByRole("button", { name: "Subscribe · Yearly" }).click();
  await expect(supporter.getByRole("button", { name: "Subscribe · Yearly" })).toBeEnabled();
  await expect(supporter.getByRole("alert")).toHaveCount(0);

  await page.evaluate(() => localStorage.setItem("koonapin.demo.play", "error"));
  await supporter.getByRole("button", { name: "Subscribe · Monthly" }).click();
  await expect(supporter.getByRole("alert")).toHaveText("Google Play couldn't finish the purchase.");
  await page.evaluate(() => localStorage.setItem("koonapin.demo.play", "unavailable"));
  await supporter.getByRole("button", { name: "Try again" }).click();
  await expect(supporter.getByRole("alert")).toHaveText("Google Play can't take this purchase on this phone right now.");

  // The server out of reach after Play's sheet: the purchase is kept and asked about again.
  await failOnce(page, "startPlayPurchase", "network", "offline");
  await supporter.getByRole("button", { name: "Try again" }).click();
  await expect(supporter.getByRole("alert")).toContainText("If you paid, the purchase is kept");
});

test("the Play build: a plan paid through Google Play whose renewal failed is fixed in Google Play", async ({ page }) => {
  await openPhone(page, { settings: { "demo.supporter": "past_due", "demo.store": "play", "demo.sync": "on" }, capabilities: PLAY });
  const you = await openYou(page);
  await expect(you.locator('[data-supporter="plan"]')).toContainText("The renewal didn't go through — fix the payment in Google Play");
  await you.locator('[data-supporter="plan"]').click();
  const plan = sheet(page, "plan");
  await expect(plan.getByRole("status")).toHaveText("The renewal didn't go through — fix the payment in Google Play");
  await recordLinks(page);
  await plan.getByRole("button", { name: "Fix payment in Google Play" }).click();
  expect(await opened(page)).toEqual([PLAY_PAGE]);
  for (const name of ["Manage", "Update card", "Switch to 5 years"]) await expect(plan.getByRole("button", { name, exact: true })).toHaveCount(0);
  for (const text of ELSEWHERE) await expect(plan).not.toContainText(text);
});

test("the Play build: a plan bought through Paddle on a computer links to no Paddle page", async ({ page }) => {
  await openPhone(page, { settings: SUPPORTER, capabilities: PLAY });
  const you = await openYou(page);
  await you.locator('[data-supporter="plan"]').click();
  const plan = sheet(page, "plan");
  await expect(plan).toContainText("Your plan is managed where you started it.");
  for (const name of ["Manage", "Manage in Google Play", "Switch to 5 years"]) await expect(plan.getByRole("button", { name, exact: true })).toHaveCount(0);
});
