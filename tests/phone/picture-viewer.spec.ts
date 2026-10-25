import { test, expect, type Page } from "@playwright/test";
import { openPhone, systemBack, topScreen } from "./fixtures";
import { ARTICLE } from "../ui/picture-viewer.spec";

// #400 on a phone (frame P4): a tap opens the picture in a card, Back or a swipe down puts it back.

const viewer = (page: Page) => page.locator("[data-picture-viewer]");

async function readerWithPicture(page: Page) {
  await openPhone(page);
  await topScreen(page).locator("[data-bookmark-id]").first().click();
  const body = topScreen(page).locator(".reader-body");
  await expect(body).toBeVisible();
  await body.evaluate((el, h) => (el.innerHTML = h), ARTICLE);
  const img = body.locator("img");
  await expect(img).toHaveJSProperty("complete", true);
  await img.scrollIntoViewIfNeeded();
  return img;
}

/** A finger's drag on the picture, as pointer events of a touch, 10 px a frame. */
const swipe = (page: Page, from: number, to: number) =>
  viewer(page)
    .locator("[data-viewer-box]")
    .evaluate(
      async (stage, [a, b]) => {
        // A frame apart, as a finger moves: the speed is part of what closes it.
        const frame = () => new Promise((resolve) => setTimeout(resolve, 16));
        const at = (type: string, y: number) =>
          stage.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: "touch", clientX: 200, clientY: y, bubbles: true, isPrimary: true }));
        at("pointerdown", a);
        for (let y = a; Math.abs(y - b) > 10; y += Math.sign(b - a) * 10) {
          await frame();
          at("pointermove", y);
        }
        await frame();
        at("pointermove", b);
        await frame();
        at("pointerup", b);
      },
      [from, to],
    );

test("a tap opens the picture; Back closes it and leaves the reader open", async ({ page }) => {
  const img = await readerWithPicture(page);
  await img.click();
  await expect(viewer(page)).toBeVisible();
  await page.waitForTimeout(380);
  await systemBack(page);
  await expect(viewer(page)).toHaveCount(0);
  await expect(topScreen(page).locator(".reader-body")).toBeVisible();
});

test("a swipe down closes it; a short one springs back", async ({ page }) => {
  const img = await readerWithPicture(page);
  await img.click();
  await page.waitForTimeout(380);
  await swipe(page, 400, 440);
  await page.waitForTimeout(380);
  await expect(viewer(page)).toBeVisible();
  await swipe(page, 400, 640);
  await expect(viewer(page)).toHaveCount(0);
});

test("reduced motion: the card still follows a swipe, and a long one closes it", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const img = await readerWithPicture(page);
  await img.click();
  await page.waitForTimeout(200);
  await swipe(page, 400, 440);
  await expect(viewer(page)).toBeVisible();
  await swipe(page, 400, 640);
  await expect(viewer(page)).toHaveCount(0);
});
