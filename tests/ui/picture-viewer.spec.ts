import { test, expect, type Page } from "@playwright/test";
import { openApp, opened, stubBrowser } from "../fixtures/app";

// #400 (frames P1–P3): a picture of the article opens in a card over it, zooms and pans inside the
// card, and the card goes back to the picture.

const grid = Array.from({ length: 16 }, (_, i) => `<line x1="${i * 100}" y1="0" x2="${i * 100}" y2="1000" stroke="#fff"/>`).join("");
export const PICTURE = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><rect width="1600" height="1000" fill="#7f93a6"/>${grid}<circle cx="800" cy="500" r="220" fill="#f4e3c3"/></svg>`,
)}`;
export const ARTICLE = `<p>A paragraph before the picture, long enough to wrap onto a second line in the column.</p>
<figure><img src="${PICTURE}" alt="A test picture"><figcaption>The caption of the picture, shown under it in the viewer.</figcaption></figure>
<p>A paragraph after it.</p>`;

const viewer = (page: Page) => page.locator("[data-picture-viewer]");
const picture = (page: Page) => viewer(page).locator("[data-viewer-picture]");
const scale = (page: Page) => picture(page).evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
/** The lift and every glide take 300 ms. */
const settled = (page: Page) => page.waitForTimeout(380);

/** Reading mode with the article's body replaced by one with a picture (the demo's has none). */
async function readingWithPicture(page: Page, html = ARTICLE, theme = "light") {
  await openApp(page, { viewport: { width: 1280, height: 800 }, settings: { openLinks: null, theme, language: "en", view: "grid" } });
  await stubBrowser(page);
  await page.locator("button[data-read-mode]").click();
  const body = page.locator("[data-reading-mode] .reader-body");
  await expect(body).toBeVisible();
  await body.evaluate((el, h) => (el.innerHTML = h), html);
  await expect(body.locator("img")).toHaveJSProperty("complete", true);
  return body.locator("img");
}

const card = (page: Page) => viewer(page).locator("[data-viewer-card]");

test("a picture opens in a card over the article, zooms and pans inside it, and closes", async ({ page }) => {
  const img = await readingWithPicture(page);
  await img.click();
  await expect(viewer(page)).toBeVisible();
  await settled(page);
  expect(await scale(page)).toBeCloseTo(1, 2);
  // Not full screen: the card leaves the article around it; its picture is clipped by the box.
  const box = (await card(page).boundingBox())!;
  expect(box.width).toBeLessThan(1280 * 0.7);
  expect(box.x).toBeGreaterThan(100);
  await expect(card(page)).toHaveCSS("opacity", "1");
  await expect(viewer(page).locator("[data-viewer-box]")).toHaveCSS("overflow", "hidden");
  await expect(viewer(page).getByText("The caption of the picture, shown under it in the viewer.")).toBeVisible();
  await expect(viewer(page).getByRole("button", { name: "Zoom out" })).toBeDisabled();
  await expect(viewer(page).getByRole("button", { name: "Close" })).toBeFocused();

  await page.keyboard.press("+");
  await page.keyboard.press("+");
  await settled(page);
  expect(await scale(page)).toBeCloseTo(2.25, 2);
  // The card does not grow with the zoom.
  expect((await card(page).boundingBox())!.width).toBeCloseTo(box.width, 0);
  const before = (await picture(page).boundingBox())!;
  await page.mouse.move(640, 400);
  await page.mouse.down();
  await page.mouse.move(540, 360, { steps: 5 });
  await page.mouse.up();
  expect((await picture(page).boundingBox())!.x).toBeLessThan(before.x - 50);
  await expect(viewer(page)).toBeVisible();

  await page.keyboard.press("0");
  await settled(page);
  await page.mouse.move(400, 300);
  await page.mouse.wheel(0, -100);
  await settled(page);
  expect(await scale(page)).toBeCloseTo(1.25, 2);
  await viewer(page).getByRole("button", { name: "Fit to window" }).click();
  await settled(page);
  expect(await scale(page)).toBeCloseTo(1, 2);

  // Escape closes the viewer only; reading mode stays, its picture where it was.
  await page.keyboard.press("Escape");
  await expect(viewer(page)).toHaveCount(0);
  await expect(page.locator("[data-reading-mode]")).toBeVisible();
  await expect(img).toBeVisible();
});

test("while it is open the reading mode's keys rest, and a click beside the card closes it", async ({ page }) => {
  const img = await readingWithPicture(page);
  await img.click();
  await settled(page);
  const title = page.locator("[data-reading-mode] .reader-title");
  const shown = await title.textContent();
  await page.keyboard.press("j");
  await expect(title).toHaveText(shown!);
  // Even zoomed in.
  await page.keyboard.press("+");
  await page.mouse.click(30, 400);
  await expect(viewer(page)).toHaveCount(0);
});

test("a double click zooms in at that point, and a second one fits again", async ({ page }) => {
  const img = await readingWithPicture(page);
  await img.click();
  await settled(page);
  const box = (await picture(page).boundingBox())!;
  await page.mouse.dblclick(box.x + box.width * 0.75, box.y + box.height / 2);
  await settled(page);
  expect(await scale(page)).toBeCloseTo(2.5, 2);
  await page.mouse.dblclick(640, 400);
  await settled(page);
  expect(await scale(page)).toBeCloseTo(1, 2);
});

test("a picture inside a link opens in the viewer, which offers the link", async ({ page }) => {
  const img = await readingWithPicture(page, `<p><a href="https://example.com/story"><img src="${PICTURE}" alt="Linked"></a></p>`);
  await img.click();
  const open = viewer(page).getByRole("button", { name: "Open link" });
  await expect(open).toBeVisible();
  await open.click();
  await expect.poll(async () => (await opened(page)).at(-1)).toBe("https://example.com/story");
});

/** A picture of the given size from a site, without the network. */
const svgOf = (width: number, height: number, fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="${fill}"/></svg>`;

test("the widest picture of the srcset replaces the shown one, and the card and its percentage stay", async ({ page }) => {
  // The large one comes a second late, so the card is seen settled before and after it.
  await page.route("https://pictures.test/**", async (route) => {
    const large = route.request().url().endsWith("large.svg");
    if (large) await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.fulfill({ contentType: "image/svg+xml", body: large ? svgOf(1600, 1000, "#3b4f6b") : svgOf(400, 250, "#c26a4a") });
  });
  const img = await readingWithPicture(
    page,
    `<figure><img src="https://pictures.test/small.svg" srcset="https://pictures.test/small.svg 400w, https://pictures.test/large.svg 1600w" sizes="200px" alt="Sized"></figure>`,
  );
  await img.click();
  await settled(page);
  // The box is sized for 1600 px from the start: 768 × 480 in a 1280 × 800 window, 48 %.
  await expect(picture(page)).toHaveAttribute("src", "https://pictures.test/small.svg");
  await expect(viewer(page).getByRole("button", { name: "Fit to window" })).toHaveText("48%");
  const before = (await card(page).boundingBox())!;
  await expect(picture(page)).toHaveAttribute("src", "https://pictures.test/large.svg");
  await expect(viewer(page).getByRole("button", { name: "Fit to window" })).toHaveText("48%");
  expect((await card(page).boundingBox())!.width).toBeCloseTo(before.width, 0);
});

test("the card takes the reading theme's colours: Dark", async ({ page }) => {
  const img = await readingWithPicture(page, ARTICLE, "dark");
  await img.click();
  await settled(page);
  await expect(card(page)).toHaveCSS("background-color", "rgb(44, 43, 39)");
});

test("reduced motion: the card fades in place, without growing out of the picture", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const img = await readingWithPicture(page);
  await img.click();
  await page.waitForTimeout(40);
  const matrix = await card(page).evaluate((el) => new DOMMatrix(getComputedStyle(el).transform));
  expect([matrix.a, matrix.e, matrix.f]).toEqual([1, 0, 0]);
  await settled(page);
  await expect(card(page)).toHaveCSS("opacity", "1");
  await page.keyboard.press("Escape");
  await expect(viewer(page)).toHaveCount(0);
});

test("a Mac trackpad's pinch (WebKit gesture events) and a Mac mouse's small wheel steps zoom", async ({ page }) => {
  const img = await readingWithPicture(page);
  await img.click();
  await settled(page);
  const box = (await viewer(page).locator("[data-viewer-box]").boundingBox())!;
  await viewer(page).locator("[data-viewer-picture]").evaluate((el, [x, y]) => {
    const gesture = (type: string, scale: number) => el.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), { scale, clientX: x, clientY: y }));
    gesture("gesturestart", 1);
    gesture("gesturechange", 1.5);
    gesture("gesturechange", 2);
    gesture("gestureend", 2);
  }, [box.x + box.width / 2, box.y + box.height / 2]);
  expect(await scale(page)).toBeCloseTo(2, 2);
  await viewer(page).getByRole("button", { name: "Fit to window" }).click();
  await settled(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -40);
  await expect.poll(() => scale(page)).toBeGreaterThan(1.5);
});

test("a picture opens from the keyboard: Tab to it, Enter", async ({ page }) => {
  const img = await readingWithPicture(page);
  await expect(img).toHaveAttribute("role", "button");
  await expect(img).toHaveAttribute("tabindex", "0");
  await img.focus();
  await page.keyboard.press("Enter");
  await expect(viewer(page)).toBeVisible();
  await expect(viewer(page).getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(viewer(page)).toHaveCount(0);
  await expect(img).toBeFocused();
});

test("Enter on a link that is only a picture opens the picture, not the browser", async ({ page }) => {
  const img = await readingWithPicture(page, `<p>Before.</p><p><a href="https://example.com/story"><img src="${PICTURE}" alt="Linked"></a></p>`);
  // The link is the tab stop; the picture in it is no button of its own.
  await expect(img).not.toHaveAttribute("role", "button");
  await page.locator("[data-reading-mode] .reader-body a").focus();
  await page.keyboard.press("Enter");
  await expect(viewer(page)).toBeVisible();
  expect(await opened(page)).toEqual([]);
  await expect(viewer(page).getByRole("button", { name: "Open link" })).toBeVisible();
});

test("a pinch without a point zooms about the middle; one whose end never came leaves the wheel working", async ({ page }) => {
  const img = await readingWithPicture(page);
  await img.click();
  await settled(page);
  await viewer(page).locator("[data-viewer-picture]").evaluate((el) => {
    const gesture = (type: string, scale: number) => el.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), { scale }));
    gesture("gesturestart", 1);
    gesture("gesturechange", 2);
    // No gestureend: the window lost focus mid-pinch.
  });
  expect(await scale(page)).toBeCloseTo(2, 2);
  const matrix = await picture(page).evaluate((el) => new DOMMatrix(getComputedStyle(el).transform));
  expect([matrix.e, matrix.f]).toEqual([0, 0]);
  await page.waitForTimeout(400);
  const box = (await viewer(page).locator("[data-viewer-box]").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 100);
  await expect.poll(() => scale(page)).toBeCloseTo(1.6, 2);
});
