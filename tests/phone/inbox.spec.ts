import { expect, type Page, test } from "@playwright/test";
import { navPill, openPhone, topScreen } from "./fixtures";

// The Inbox on a phone (NP-072b, frames I1–I3 and E1): triage with the decision pill and swipes,
// undo through the snackbar, the done state and the empty one.

const openInbox = async (page: Page) => {
  await openPhone(page);
  await navPill(page).getByRole("button", { name: "Inbox" }).click();
  await expect(topScreen(page).getByRole("heading", { level: 1 })).toHaveText("Sort inbox");
};
const card = (page: Page) => page.locator('[data-triage-card][data-slot="0"]');
const pill = (page: Page) => page.locator("[data-decision-pill]");
const snackbar = (page: Page) => page.locator("[data-snackbar]");
/** "3 of 12" beside the title. */
const count = (page: Page) => topScreen(page).locator(".inb-count");

/** A finger on the card from its middle, `dx` sideways, in small steps; `from` overrides the start x. */
async function drag(page: Page, dx: number, from?: number) {
  const box = (await card(page).boundingBox())!;
  const x = from ?? box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 6 });
  await page.mouse.move(x + dx, y, { steps: 6 });
  await page.mouse.up();
}

test("Keep moves on; the snackbar's Undo brings the card back", async ({ page }) => {
  await openInbox(page);
  const first = await card(page).getAttribute("data-triage-card");
  const total = Number((await count(page).textContent())!.split(" of ")[1]);
  expect(total).toBeGreaterThan(1);
  await expect(count(page)).toHaveText(`1 of ${total}`);
  // No account cluster in triage: Done instead.
  await expect(topScreen(page).locator("[data-account]")).toHaveCount(0);

  await pill(page).getByRole("button", { name: "Keep" }).click();
  await expect(count(page)).toHaveText(`2 of ${total}`);
  await expect(card(page)).not.toHaveAttribute("data-triage-card", first!);
  await expect(snackbar(page)).toContainText("Kept · ");
  // Above the decision pill, not over it.
  const bar = (await snackbar(page).boundingBox())!;
  const decide = (await pill(page).boundingBox())!;
  expect(bar.y + bar.height).toBeLessThanOrEqual(decide.y);

  await snackbar(page).getByRole("button", { name: "Undo" }).click();
  await expect(card(page)).toHaveAttribute("data-triage-card", first!);
  await expect(count(page)).toHaveText(`1 of ${total}`);
  await expect(snackbar(page)).toContainText("Back in the queue");
});

test("a swipe left past the threshold trashes, a short one springs back, one from the edge is ignored", async ({ page }) => {
  await openInbox(page);
  const first = await card(page).getAttribute("data-triage-card");
  const total = Number((await count(page).textContent())!.split(" of ")[1]);

  await drag(page, -50);
  await expect(card(page)).toHaveAttribute("data-triage-card", first!);
  await expect(count(page)).toHaveText(/^1 of/);

  // From within 24 dp of the screen's left edge: the system's Back gesture, not ours.
  await drag(page, 200, 22);
  await expect(card(page)).toHaveAttribute("data-triage-card", first!);

  await drag(page, -180);
  await expect(snackbar(page)).toContainText("Moved to trash · ");
  await expect(count(page)).toHaveText(/^2 of/);
  await expect(card(page)).not.toHaveAttribute("data-triage-card", first!);

  // Right keeps.
  await drag(page, 180);
  await expect(snackbar(page)).toContainText("Kept · ");
  if (total > 2) await expect(count(page)).toHaveText(/^3 of/);
  else await expect(page.locator("[data-inbox-sorted]")).toBeVisible();
});

test("dragging toward Trash presses Trash and steps Keep back", async ({ page }) => {
  await openInbox(page);
  const box = (await card(page).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 140, y, { steps: 8 });
  await expect(pill(page).getByRole("button", { name: "Trash" })).toHaveAttribute("data-pressed");
  await expect(pill(page).getByRole("button", { name: "Keep" })).toHaveAttribute("data-recede");
  await expect(card(page).locator(".inb-swipe-label")).toHaveText("Move to trash");
  // Back to the middle: nothing decided.
  await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.up();
  await expect(count(page)).toHaveText(/^1 of/);
  await expect(pill(page).getByRole("button", { name: "Keep" })).not.toHaveAttribute("data-recede");
});

test("Reading keeps the link and adds it to Reading", async ({ page }) => {
  await openInbox(page);
  const title = await card(page).locator("h2").textContent();
  await pill(page).getByRole("button", { name: "Reading" }).click();
  await expect(snackbar(page)).toContainText("Added to Reading · ");
  await navPill(page).getByRole("button", { name: "Reading" }).click();
  await expect(topScreen(page).getByText(title!, { exact: true }).first()).toBeAttached();
});

test("a collection chip files the card", async ({ page }) => {
  await openInbox(page);
  const chip = topScreen(page).locator("[data-collection-chips] button").first();
  const name = (await chip.locator("[data-user-text]").textContent())!;
  await chip.click();
  await expect(snackbar(page)).toContainText(`Filed in ${name} · `);
  await expect(count(page)).toHaveText(/^2 of/);
  // "More" opens the collection picker for the card on screen.
  await topScreen(page).locator("[data-collection-chips]").getByRole("button", { name: "More" }).click();
  await expect(page.locator('[data-sheet-kind="collectionPicker"]').getByRole("dialog")).toBeVisible();
});

test("the inbox sorted: summary, undo of the last decision, then the library; empty afterwards", async ({ page }) => {
  await openInbox(page);
  const total = Number((await count(page).textContent())!.split(" of ")[1]);
  for (let i = 0; i < total; i++) {
    const kind = i === 0 ? "Trash" : i === 1 ? "Reading" : "Keep";
    await pill(page).getByRole("button", { name: kind }).click();
    if (i < total - 1) await expect(count(page)).toHaveText(`${i + 2} of ${total}`);
  }
  const sorted = page.locator("[data-inbox-sorted]");
  await expect(sorted.getByRole("heading", { name: "Inbox sorted" })).toBeVisible();
  await expect(sorted).toContainText(`${total} decisions in about 1 minute`);
  await expect(sorted.locator(".inb-stat", { hasText: "Moved to trash" })).toContainText("1");
  await expect(sorted.locator(".inb-stat", { hasText: "Kept in library" })).toContainText(String(total - 2));
  await expect(sorted.locator(".inb-stat", { hasText: "Added to Reading" })).toContainText("1");

  await sorted.getByRole("button", { name: "Undo last decision" }).click();
  await expect(card(page)).toBeVisible();
  await expect(count(page)).toHaveText(`${total} of ${total}`);
  await pill(page).getByRole("button", { name: "Keep" }).click();
  await expect(sorted).toBeVisible();

  await sorted.getByRole("button", { name: "Go to library" }).click();
  await expect(navPill(page).getByRole("button", { name: "All bookmarks" })).toHaveAttribute("aria-current", "page");

  // Back in the Inbox nothing waits: E1, with the cluster again and a tip that fits the phone.
  await navPill(page).getByRole("button", { name: "Inbox" }).click();
  const empty = page.locator("[data-inbox-empty]");
  await expect(empty.getByRole("heading", { name: "All sorted" })).toBeVisible();
  await expect(topScreen(page).getByRole("heading", { level: 1 })).toHaveText("Inbox");
  await expect(topScreen(page).locator("[data-account]")).toBeVisible();
  // The fixture's phone has no share intake: the tip is "+".
  await expect(empty).toContainText("Add a link with +");
  await empty.getByRole("button", { name: "New link" }).click();
  await expect(page.locator('[data-sheet-kind="newLink"]').getByRole("dialog")).toBeVisible();
});

test("a tap on the card opens it in the reader; Back returns to the same card", async ({ page }) => {
  await openInbox(page);
  const first = await card(page).getAttribute("data-triage-card");
  const title = await card(page).locator("h2").textContent();
  await card(page).locator("h2").click();
  await expect(topScreen(page)).toHaveAttribute("data-route");
  await expect(topScreen(page).getByRole("heading", { level: 1 })).toHaveText(title!);
  await topScreen(page).getByRole("button", { name: "Back" }).click();
  await expect(card(page)).toHaveAttribute("data-triage-card", first!);
});

test("Done leaves triage for the library", async ({ page }) => {
  await openInbox(page);
  await topScreen(page).getByRole("button", { name: "Done" }).click();
  await expect(navPill(page).getByRole("button", { name: "All bookmarks" })).toHaveAttribute("aria-current", "page");
});
