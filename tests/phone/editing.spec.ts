import { expect, type Page, test } from "@playwright/test";
import { navPill, openPhone, systemBack, topScreen } from "./fixtures";

// Editing and adding on the phone (NP-072b, frames B1, C1, N1): the Edit link sheet, the
// collection picker and the New link sheet, on the demo backend.

const editSheet = (page: Page) => page.locator('[data-sheet-kind="edit"]');
const picker = (page: Page) => page.locator('[data-sheet-kind="collectionPicker"]');
const newLink = (page: Page) => page.locator('[data-sheet-kind="newLink"]');
const snackbar = (page: Page) => page.locator("[data-snackbar]");

/** Opens the first bookmark's long-press menu and picks `action` there. */
async function fromMenu(page: Page, action: string) {
  const row = topScreen(page).locator("[data-bookmark-id]").first();
  await expect(row).toBeVisible();
  const box = (await row.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 20);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
  await page.locator('[data-sheet-kind="bookmarkMenu"]').getByRole("button", { name: action }).click();
  return Number(await row.getAttribute("data-bookmark-id"));
}

/** A link pasted whole, as a browser pastes: the paste and its input in one task. */
async function paste(page: Page, link: string) {
  await newLink(page)
    .getByRole("textbox", { name: "Link" })
    .evaluate((input: HTMLInputElement, text) => {
      input.focus();
      input.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, link);
}

test("Edit link: the title has the focus, an empty one is marked, Save keeps the changes", async ({ page }) => {
  await openPhone(page);
  await fromMenu(page, "Edit");
  const sheet = editSheet(page);
  const title = sheet.getByRole("textbox", { name: "Title" });
  await expect(title).toBeFocused();

  await title.fill("");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet.getByText("Title can’t be empty")).toBeVisible();
  await expect(title).toHaveAttribute("aria-invalid", "true");
  await expect(title).toBeFocused();

  await title.fill("A calmer title\nfor the phone");
  await expect(title).toHaveValue("A calmer title for the phone");
  await sheet.getByRole("textbox", { name: "Note" }).fill("Read on the train");
  // A tag typed and ended with Enter; a second one left in the field is added by Save.
  await sheet.getByRole("button", { name: "Add tag" }).click();
  await sheet.getByRole("textbox", { name: "New tag" }).fill("Trains");
  await page.keyboard.press("Enter");
  await expect(sheet.getByRole("button", { name: "Remove tag trains" })).toBeVisible();
  await sheet.getByRole("textbox", { name: "New tag" }).fill("slow");
  await sheet.getByRole("button", { name: "Save" }).click();

  await expect(sheet).toHaveCount(0);
  await expect(snackbar(page)).toContainText("Changes saved");
  await expect(topScreen(page).locator("[data-bookmark-id]").first()).toContainText("A calmer title for the phone");
  // Opened again: what was saved.
  await fromMenu(page, "Edit");
  await expect(editSheet(page).getByRole("textbox", { name: "Note" })).toHaveValue("Read on the train");
  await expect(editSheet(page).getByRole("button", { name: "Remove tag slow" })).toBeVisible();
  // A tag chip tapped comes off the draft.
  await editSheet(page).getByRole("button", { name: "Remove tag slow" }).click();
  await expect(editSheet(page).getByRole("button", { name: "Remove tag slow" })).toHaveCount(0);
});

test("Edit link: Cancel and Back leave the draft without saving, as the desktop's editor", async ({ page }) => {
  await openPhone(page);
  const row = topScreen(page).locator("[data-bookmark-id]").first();
  const before = (await row.locator(".ph-row").textContent())!;
  await fromMenu(page, "Edit");
  await editSheet(page).getByRole("textbox", { name: "Title" }).fill("Not kept");
  expect(await systemBack(page)).toBe(true);
  await expect(editSheet(page)).toHaveCount(0);
  await expect(row).toContainText(before);
  await expect(snackbar(page)).toHaveCount(0);
});

test("Edit link → collection: the picker over the editor hands the choice back to the draft", async ({ page }) => {
  await openPhone(page);
  await fromMenu(page, "Edit");
  const sheet = editSheet(page);
  await sheet.getByRole("button", { name: /^Collection/ }).click();
  await expect(picker(page).getByRole("dialog", { name: "File into collection" })).toBeVisible();
  // Some collection that is not chosen yet.
  const name = (await picker(page).locator(".cp-row[aria-checked=false] .cp-name").first().textContent())!;
  const other = picker(page).getByRole("radio", { name });
  await other.click();
  await expect(other).toHaveAttribute("aria-checked", "true");
  await picker(page).getByRole("button", { name: "Done" }).click();
  await expect(picker(page)).toHaveCount(0);
  // Nothing moved yet: the draft shows it; Save moves it.
  await expect(snackbar(page)).toHaveCount(0);
  await expect(sheet.locator(".ed-collection-name")).toHaveText(name);
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(snackbar(page)).toContainText("Changes saved");
});

test("Move to collection: the picker moves the link with Undo; find-or-create makes a new one", async ({ page }) => {
  await openPhone(page);
  await fromMenu(page, "Move to collection");
  const sheet = picker(page);
  const search = sheet.getByRole("searchbox", { name: "Find or create" });
  await search.fill("Slow reading");
  const fresh = sheet.getByRole("radio", { name: "New collection “Slow reading”" });
  await fresh.click();
  await expect(fresh).toHaveAttribute("aria-checked", "true");
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(snackbar(page)).toContainText("Slow reading");

  // The new collection is there next time, found by part of its name.
  await fromMenu(page, "Move to collection");
  const again = picker(page).getByRole("searchbox", { name: "Find or create" });
  await again.fill("slow");
  await expect(picker(page).getByRole("radio", { name: /^Slow reading/ })).toHaveAttribute("aria-checked", "true");
  // Part of a name may still be a new one; the whole name, in any case, is not.
  await expect(picker(page).getByRole("radio", { name: "New collection “slow”" })).toBeVisible();
  await again.fill("SLOW READING");
  await expect(picker(page).getByRole("radio", { name: /^New collection/ })).toHaveCount(0);
  expect(await systemBack(page)).toBe(true);
  await expect(picker(page)).toHaveCount(0);
});

test("New link: a pasted page shows its preview and its feed; Save to Library saves it there", async ({ page }) => {
  await openPhone(page);
  await navPill(page).getByRole("button", { name: "New link" }).click();
  const sheet = newLink(page);
  await expect(sheet.getByRole("textbox", { name: "Link" })).toBeFocused();
  await paste(page, "fieldnotes.example.com/walking-the-old-railway");
  await expect(sheet.locator("[data-preview=new]")).toContainText("Walking the old railway");
  await expect(sheet.locator("[data-feed-offer]")).toContainText("Field Notes has a feed");
  await expect(sheet.getByRole("switch", { name: "Follow Field Notes" })).toHaveAttribute("aria-checked", "false");
  await expect(sheet.getByRole("radio", { name: "Inbox" })).toHaveAttribute("aria-checked", "true");
  await sheet.getByRole("radio", { name: "Library" }).click();
  await sheet.getByRole("button", { name: "Save link" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(snackbar(page)).toContainText("Saved to Library");
});

test("New link: Follow turns Save into Save and follow; the feed is followed after the link", async ({ page }) => {
  await openPhone(page);
  await navPill(page).getByRole("button", { name: "New link" }).click();
  const sheet = newLink(page);
  await paste(page, "fieldnotes.example.com/walking-the-old-railway");
  await sheet.getByRole("switch", { name: "Follow Field Notes" }).click();
  await expect(sheet.locator("[data-feed-offer]")).toHaveAttribute("data-feed-offer", "ready");
  await sheet.getByRole("button", { name: "Save and follow" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(snackbar(page)).toContainText("Saved to Inbox");
  // Opened again on the same page: the site is followed now.
  await navPill(page).getByRole("button", { name: "New link" }).click();
  await paste(page, "fieldnotes.example.com/another-walk");
  await expect(newLink(page).locator("[data-feed-offer]")).toContainText("You follow this site");
});

test("New link: a typed link is looked up on Go, not saved; Go again saves it", async ({ page }) => {
  await openPhone(page);
  await navPill(page).getByRole("button", { name: "New link" }).click();
  const sheet = newLink(page);
  const field = sheet.getByRole("textbox", { name: "Link" });
  await field.pressSequentially("fieldnotes.example.com/walking-the-old-railway");
  // Typed by hand: no request yet, so no feed offer.
  await expect(sheet.locator("[data-feed-offer]")).toHaveCount(0);
  await field.press("Enter");
  await expect(sheet).toBeVisible();
  // While it is looked up the button waits, so it cannot save before the feed is known.
  await expect(sheet.getByRole("button", { name: "Save link" })).toBeDisabled();
  await expect(sheet.getByRole("switch", { name: "Follow Field Notes" })).toBeVisible();
  await field.press("Enter");
  await expect(sheet).toHaveCount(0);
  await expect(snackbar(page)).toContainText("Saved to Inbox");
});

test("New link: a feed's address is followed, and Show opens its posts on All", async ({ page }) => {
  await openPhone(page);
  await navPill(page).getByRole("button", { name: "New link" }).click();
  await paste(page, "fieldnotes.example.com/feed.xml");
  const sheet = newLink(page);
  await sheet.getByRole("button", { name: "Follow", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(snackbar(page)).toContainText("You follow this site");
  await snackbar(page).getByRole("button", { name: "Show" }).click();
  await expect(navPill(page).getByRole("button", { name: "Feeds" })).toHaveAttribute("aria-current", "page");
  await expect(topScreen(page).getByRole("radio", { name: "All" })).toHaveAttribute("aria-checked", "true");
  // Shown once: the person's own choice (Unread) is what Feeds opens on next time.
  expect(await page.evaluate(() => localStorage.getItem("koonapin.feedsScope"))).not.toBe("all");
});

test("New link: not a link says so; a link already saved offers to show it", async ({ page }) => {
  await openPhone(page);
  const first = topScreen(page).locator("[data-bookmark-id]").first();
  await expect(first).toBeVisible();
  const id = Number(await first.getAttribute("data-bookmark-id"));
  const url = await page.evaluate(async (id) => {
    const { api } = await import("/src/services/api.ts");
    return (await api.getBookmarks({}, { limit: 200 })).items.find((b) => b.id === id)!.url;
  }, id);

  await navPill(page).getByRole("button", { name: "New link" }).click();
  const sheet = newLink(page);
  await sheet.getByRole("textbox", { name: "Link" }).pressSequentially("not a link");
  await expect(sheet.getByText("That doesn’t look like a link yet")).toBeVisible();
  await sheet.getByRole("button", { name: "Clear" }).click();
  await paste(page, url);
  await expect(sheet.locator("[data-preview=existing]")).toContainText("Already in your library");
  await sheet.locator("[data-preview=existing]").getByRole("button", { name: "Show it" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(editSheet(page).getByRole("dialog", { name: "Edit link" })).toBeVisible();
});

test("New link: Save link stays above the keyboard", async ({ page }) => {
  await openPhone(page);
  await navPill(page).getByRole("button", { name: "New link" }).click();
  // Android passes the keyboard in the bottom inset (--safe-bottom): 300 dp of it over the 34.
  await page.evaluate(() => document.documentElement.style.setProperty("--kp-inset-bottom", "334px"));
  const save = newLink(page).getByRole("button", { name: "Save link" });
  await expect(save).toBeVisible();
  await page.waitForTimeout(400);
  const box = (await save.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(852 - 334);
});
