import { test, expect, Page } from "@playwright/test";
import { openApp } from "../fixtures/app";

// The grid on Linux: WebKitGTK under Wayland scrolled the grid slowly while the list stayed smooth.
// There the grid draws no backdrop blur and no blurred copy of a picture (`app.css`, «Linux»);
// elsewhere its glass is unchanged.

const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
/** The suite runs on Linux in CI too: the other side names Windows. */
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";

/** The grid of the demo with the first bookmark's picture gone: its card shows the poster cover and its chip. */
async function gridWithPoster(page: Page) {
  await openApp(page, { viewport: { width: 1440, height: 900 }, settings: { view: "grid" }, cards: 6 });
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const bookmarks = (await api.getBookmarks()).items;
    bookmarks[0].image_url = null;
    localStorage.setItem("koonapin.demo.v4", JSON.stringify({ bookmarks, collections: await api.getCollections() }));
  });
  await page.reload();
  const poster = page.locator('[data-bookmark-id="1"]');
  await expect(poster.locator(".cover-chip")).toBeVisible();
  return poster;
}

/** Adds three bookmarks to the bundle so its capsule appears on the current page. */
async function showCapsule(page: Page) {
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const { bundle } = await import("/src/services/bundle.ts");
    bundle.addBookmarks((await api.getBookmarks()).items.slice(0, 3));
  });
  const capsule = page.locator("[data-bundle-capsule]");
  await expect(capsule).toBeVisible();
  return capsule;
}

test.describe("on Linux", () => {
  test.use({ userAgent: LINUX });

  test("grid cards and bundle capsule draw no backdrop blur, no blurred halo, and no light sweep", async ({ page }) => {
    const poster = await gridWithPoster(page);
    await expect(page.locator("html")).toHaveAttribute("data-linux", "");
    await expect(poster.locator(".cover-chip")).toHaveCSS("backdrop-filter", "none");

    // Hovered: the corner buttons show, as tints; the cover holds still.
    await poster.locator("[data-ring]").hover();
    const action = poster.locator(".card-action").first();
    await expect(action).toHaveCSS("opacity", "1");
    await expect(action).toHaveCSS("backdrop-filter", "none");
    await expect(poster.locator(".cover")).toHaveCSS("animation-name", "none");

    // Selected: the check without blur, the halo in its cover's colours only.
    const other = page.locator('[data-bookmark-id="2"]');
    await other.locator("h2").click();
    await expect(other).toHaveAttribute("data-selected", "true");
    await expect(other.locator(".card-check")).toHaveCSS("opacity", "1");
    await expect(other.locator(".card-check")).toHaveCSS("backdrop-filter", "none");
    const halo = other.locator(".card-halo");
    await expect(halo).toHaveCSS("filter", "none");
    await expect(halo).toHaveCSS("background-image", /^linear-gradient/);

    // Bundle capsule: no backdrop blur, plain 2 px ring, no light sweep.
    const shell = (await showCapsule(page)).locator(".bundle-shell");
    await expect(shell).toHaveCSS("backdrop-filter", "none");
    await expect(shell.locator(".bundle-sweep")).toHaveCSS("display", "none");
    await expect(page.locator(".bundle-glow")).toHaveCSS("box-shadow", /0px 0px 0px 2px inset$/);
  });
});

test.describe("elsewhere", () => {
  test.use({ userAgent: WINDOWS });

  test("grid cards and bundle capsule keep their glass and light sweep", async ({ page }) => {
    const poster = await gridWithPoster(page);
    await expect(page.locator("html")).not.toHaveAttribute("data-linux");
    await expect(poster.locator(".cover-chip")).toHaveCSS("backdrop-filter", "blur(6px)");
    await poster.locator("[data-ring]").hover();
    await expect(poster.locator(".card-action").first()).toHaveCSS("backdrop-filter", "blur(20px) saturate(1.8)");
    const other = page.locator('[data-bookmark-id="2"]');
    await other.locator("h2").click();
    await expect(other.locator(".card-halo")).toHaveCSS("filter", "blur(18px) saturate(1.6) brightness(1.06)");
    await expect(other.locator(".card-halo")).toHaveCSS("background-image", /^url\(.+\), linear-gradient/);

    const shell = (await showCapsule(page)).locator(".bundle-shell");
    await expect(shell).toHaveCSS("backdrop-filter", "blur(24px) saturate(1.7)");
    await expect(shell.locator(".bundle-sweep")).toHaveCSS("display", "block");
    await expect(page.locator(".bundle-glow")).toHaveCSS("box-shadow", /0px 0px 24px 6px$/);
  });
});
