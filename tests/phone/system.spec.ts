import { test, expect, type Locator } from "@playwright/test";
import { navPill, openPhone, systemChanged } from "./fixtures";

// The system's signals (NP-072b, src/platform/system.ts): Android's battery saver and a low-RAM
// device draw the glass as opaque paper ("Glass levels", the fallback), from the first render on
// and whenever battery saver turns on or off.

const backdrop = (el: Locator) => el.evaluate((node) => getComputedStyle(node).backdropFilter);
const background = (el: Locator) => el.evaluate((node) => getComputedStyle(node).backgroundColor);

test("battery saver at the start: the first render draws the glass flat", async ({ page }) => {
  await openPhone(page, { system: { powerSave: true, lowRam: false, textScale: 1 } });
  await expect(page.locator("[data-phone]")).toHaveAttribute("data-glass", "flat");
  const pill = navPill(page);
  expect(await backdrop(pill)).toBe("none");
  // Opaque paper, not paper at 70 %.
  expect(await background(pill)).toBe("rgb(255, 254, 250)");
});

test("a low-RAM device draws the glass flat too", async ({ page }) => {
  await openPhone(page, { system: { powerSave: false, lowRam: true, textScale: 1 } });
  await expect(page.locator("[data-phone]")).toHaveAttribute("data-glass", "flat");
});

test("battery saver turned on and off: the glass follows, the layout stays", async ({ page }) => {
  await openPhone(page);
  const root = page.locator("[data-phone]");
  const pill = navPill(page);
  await expect(root).not.toHaveAttribute("data-glass");
  expect(await backdrop(pill)).toContain("blur(20px)");
  const box = await pill.boundingBox();

  await systemChanged(page, { powerSave: true, lowRam: false, textScale: 1 });
  await expect(root).toHaveAttribute("data-glass", "flat");
  expect(await backdrop(pill)).toBe("none");
  expect(await pill.boundingBox()).toEqual(box);

  await systemChanged(page, { powerSave: false, lowRam: false, textScale: 1 });
  await expect(root).not.toHaveAttribute("data-glass");
  expect(await backdrop(pill)).toContain("blur(20px)");
});

// The system's font size reaches the page as the WebView's text zoom, which the fixture plays by
// scaling the page's font sizes and line heights (tests/phone/fixtures.ts, textZoom): the badge
// keeps its size, and at the accessibility sizes a Settings row's value goes under its name.

test("the text scale: the nav pill's badge keeps its size", async ({ page }) => {
  await openPhone(page, { system: { powerSave: false, lowRam: false, textScale: 2 } });
  const root = page.locator("[data-phone]");
  await expect(root).toHaveAttribute("data-text-large", "true");
  // The page asks for 5.5 px, which the WebView's zoom draws at the designed 11.
  const badge = navPill(page).locator(".ph-badge");
  expect(await badge.evaluate((node) => getComputedStyle(node).fontSize)).toBe("11px");
  expect((await badge.boundingBox())!.height).toBe(20);
});

test("1.5 is not an accessibility size yet; 1.8 is, and a row's value goes under its name", async ({ page }) => {
  await openPhone(page, { system: { powerSave: false, lowRam: false, textScale: 1.5 } });
  const root = page.locator("[data-phone]");
  await expect(root).not.toHaveAttribute("data-text-large");
  const row = () => page.locator("[data-sheet-kind] .ph-shelf-row", { hasText: "Appearance" });
  await page.locator("[data-account]").first().click();
  const beside = await row().evaluate((node) => {
    const title = node.querySelector(".ph-shelf-title")!.getBoundingClientRect();
    const detail = node.querySelector(".ph-shelf-detail")!.getBoundingClientRect();
    return detail.left > title.right && Math.abs(detail.top - title.top) < 4;
  });
  expect(beside).toBe(true);

  await systemChanged(page, { powerSave: false, lowRam: false, textScale: 1.8 });
  await expect(root).toHaveAttribute("data-text-large", "true");
  const under = await row().evaluate((node) => {
    const title = node.querySelector(".ph-shelf-title")!.getBoundingClientRect();
    const detail = node.querySelector(".ph-shelf-detail")!.getBoundingClientRect();
    return { below: detail.top >= title.bottom - 1, aligned: Math.abs(detail.left - title.left) < 1 };
  });
  expect(under).toEqual({ below: true, aligned: true });
});

/** Whether `node`'s text runs to one line: no taller than its line height, and no word broken. */
const oneLine = (node: Element) => node.getBoundingClientRect().height <= parseFloat(getComputedStyle(node).lineHeight) + 1;

test("the reader's chosen theme repaints the flat glass: White in a dark app on battery saver", async ({ page }) => {
  await openPhone(page, { theme: "dark", system: { powerSave: true, lowRam: false, textScale: 1 } });
  const screen = page.locator("[data-screen]:not([hidden])").last();
  await screen.locator("[data-bookmark-id]").first().click();
  const reader = page.locator("[data-screen]:not([hidden])").last();
  await expect(reader).toHaveAttribute("data-route");
  await reader.getByRole("button", { name: "Text and theme" }).click();
  await page.locator('[data-sheet-kind="readerLook"]').getByRole("radio", { name: "White" }).click();
  await expect(reader).toHaveAttribute("data-page", "light");
  // The circles' slab is the page's raised colour, not the dark app's: their dark icons show.
  const colours = await reader.evaluate((node) => {
    const probe = document.createElement("div");
    probe.style.background = "var(--ph-raised)";
    node.append(probe);
    const raised = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const circle = node.querySelector(".rd-bar .ph-glass")!;
    return { raised, circle: getComputedStyle(circle).backgroundColor };
  });
  expect(colours.circle).toBe(colours.raised);
  expect(colours.circle).not.toBe("rgb(38, 38, 36)");
});

test("at an accessibility size a Settings name has the row: it does not wrap at 60 %", async ({ page }) => {
  await openPhone(page, { system: { powerSave: false, lowRam: false, textScale: 1.8 }, settings: { language: "ru" } });
  await page.locator("[data-account]").first().click();
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  const title = page.locator(".st-shelf .ph-shelf-title", { hasText: "Резервные копии" });
  await expect(title).toBeVisible();
  expect(await title.evaluate(oneLine)).toBe(true);
});
