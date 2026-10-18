import { test, expect } from "@playwright/test";
import { navPill, openPhone } from "./fixtures";

// The phone's kit and its glass rules (NP-072b wave 0, doc/mobile-design.md "Performance rules").

test("glass only on floating chrome; the flat flag turns it into opaque paper", async ({ page }) => {
  await openPhone(page);
  await expect(navPill(page)).toHaveCSS("backdrop-filter", "blur(20px) saturate(1.5)");
  // Content is never glass: rows, shelves, chips.
  for (const selector of [".ph-shelf, .lib-shelf", ".ph-shelf-row, .lib-row", "[data-bookmark-id]"])
    await expect(page.locator(selector).first()).toHaveCSS("backdrop-filter", "none");

  await page.locator("[data-phone]").evaluate((root) => root.setAttribute("data-glass", "flat"));
  await expect(navPill(page)).toHaveCSS("backdrop-filter", "none");
  await expect(navPill(page)).toHaveCSS("background-color", "rgb(255, 254, 250)");
});

test("the kit gallery renders every component of the Components board", async ({ page }) => {
  await openPhone(page);
  await page.evaluate(async () => {
    const { mountKitGallery } = await import("/src/shell/phone/ui/KitGallery.tsx");
    mountKitGallery();
  });
  const kit = page.locator("[data-kit]");
  await expect(kit.locator("[data-navpill]")).toHaveCount(3);
  await expect(kit.locator("[data-snackbar]")).toHaveCount(2);
  // Four sync states and the free gear, and the header's.
  await expect(kit.locator("[data-account]")).toHaveCount(6);
  await expect(kit.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "5 of 12");
  await expect(kit.getByRole("switch")).toHaveCount(2);
  await expect(kit.getByRole("radiogroup")).toHaveCount(2);
  await expect(kit.locator("[data-sheet]")).toHaveCount(1);
  // Every control takes at least 48 × 48 to touch, whatever it draws.
  const small = await kit.locator(".ph-hit").evaluateAll((els) =>
    els
      .map((el) => {
        const after = getComputedStyle(el, "::after");
        const box = el.getBoundingClientRect();
        return { label: el.getAttribute("aria-label") ?? el.textContent, w: Math.max(box.width, parseFloat(after.width) || 0), h: Math.max(box.height, parseFloat(after.height) || 0) };
      })
      .filter((t) => t.w < 48 || t.h < 48),
  );
  expect(small).toEqual([]);
});
