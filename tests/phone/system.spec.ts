import { test, expect, type Locator } from "@playwright/test";
import { navPill, openPhone, systemChanged } from "./fixtures";

// The system's signals (NP-072b, src/platform/system.ts): Android's battery saver and a low-RAM
// device draw the glass as opaque paper ("Glass levels", the fallback), from the first render on
// and whenever battery saver turns on or off.

const backdrop = (el: Locator) => el.evaluate((node) => getComputedStyle(node).backdropFilter);
const background = (el: Locator) => el.evaluate((node) => getComputedStyle(node).backgroundColor);

test("battery saver draws glass flat from first render and toggles without shifting layout", async ({ page }) => {
  await openPhone(page, { system: { powerSave: true, lowRam: false, textScale: 1 } });
  const root = page.locator("[data-phone]");
  const pill = navPill(page);
  await expect(root).toHaveAttribute("data-glass", "flat");
  expect(await backdrop(pill)).toBe("none");
  // Opaque paper, not paper at 70 %.
  expect(await background(pill)).toBe("rgb(255, 254, 250)");
  const box = await pill.boundingBox();

  await systemChanged(page, { powerSave: false, lowRam: false, textScale: 1 });
  await expect(root).not.toHaveAttribute("data-glass");
  expect(await backdrop(pill)).toContain("blur(20px)");
  expect(await pill.boundingBox()).toEqual(box);

  await systemChanged(page, { powerSave: true, lowRam: false, textScale: 1 });
  await expect(root).toHaveAttribute("data-glass", "flat");
  expect(await backdrop(pill)).toBe("none");
  expect(await pill.boundingBox()).toEqual(box);
});

// The system's font size reaches the page as the WebView's text zoom, which the fixture plays by
// scaling the page's font sizes and line heights (tests/phone/fixtures.ts, textZoom): the badge
// keeps its size, and at the accessibility sizes a Settings row's value goes under its name.

test("text scale: 1.5 stays inline, 1.8 stacks Settings values, and 2.0 keeps badge size", async ({ page }) => {
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

  await systemChanged(page, { powerSave: false, lowRam: false, textScale: 2 });
  // The page asks for 5.5 px, which the WebView's zoom draws at the designed 11.
  const badge = navPill(page).locator(".ph-badge");
  expect(await badge.evaluate((node) => getComputedStyle(node).fontSize)).toBe("11px");
  expect((await badge.boundingBox())!.height).toBe(20);
});

/** Whether `node`'s text runs to one line: it is no taller than its line height. */
const oneLine = (node: Element) => node.getBoundingClientRect().height <= parseFloat(getComputedStyle(node).lineHeight) + 1;

// A reading theme of the other tone than the app's, under each opaque fallback: the circles take
// the page's raised slab (an opaque colour the look sets), not the app's slab nor translucent glass.
const OPAQUE = [
  { name: "battery saver: White in a dark app", app: "dark" as const, powerSave: true, reduce: false, theme: "White", page: "light" },
  { name: "Reduce Transparency: Dark in a light app", app: "light" as const, powerSave: false, reduce: true, theme: "Dark", page: "dark" },
];
for (const { name, app, powerSave, reduce, theme, page: tone } of OPAQUE) {
  test(`the reader's chosen theme repaints the opaque glass, ${name}`, async ({ page }) => {
    if (reduce) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
    }
    await openPhone(page, { theme: app, system: { powerSave, lowRam: false, textScale: 1 } });
    // App chrome itself uses the opaque raised slab under both fallbacks.
    const pill = navPill(page);
    expect(await backdrop(pill)).toBe("none");
    expect(await background(pill)).toBe(app === "dark" ? "rgb(38, 38, 36)" : "rgb(255, 254, 250)");
    await page.locator("[data-screen]:not([hidden])").last().locator("[data-bookmark-id]").first().click();
    const reader = page.locator("[data-screen]:not([hidden])").last();
    await expect(reader).toHaveAttribute("data-route");
    await reader.getByRole("button", { name: "Text and theme" }).click();
    await page.locator('[data-sheet-kind="readerLook"]').getByRole("radio", { name: theme }).click();
    await expect(reader).toHaveAttribute("data-page", tone);
    const colours = await reader.evaluate((node) => {
      const probe = document.createElement("div");
      probe.style.background = "var(--ph-raised)";
      node.append(probe);
      const raised = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { raised, circle: getComputedStyle(node.querySelector(".rd-bar .ph-glass")!).backgroundColor };
    });
    expect(colours.circle).toBe(colours.raised);
    // Opaque: no alpha in it (translucent glass reads rgba).
    expect(colours.circle).toMatch(/^rgb\(/);
  });
}

test("at an accessibility size a Settings name has the row: it does not wrap at 60 %", async ({ page }) => {
  await openPhone(page, { system: { powerSave: false, lowRam: false, textScale: 1.8 }, settings: { language: "ru" } });
  await page.locator("[data-account]").first().click();
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  const title = page.locator(".st-shelf .ph-shelf-title", { hasText: "Резервные копии" });
  await expect(title).toBeVisible();
  expect(await title.evaluate(oneLine)).toBe(true);
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
