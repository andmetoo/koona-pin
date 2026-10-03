import { test, expect } from "@playwright/test";

// Baselines of iteration 1 (NP-010); compare with frames 01, 02, 06, 07, 16.
for (const width of [800, 1200, 1600]) {
  for (const theme of ["light", "dark"]) {
    for (const view of ["grid", "list"]) {
      test(`library ${theme} ${view} ${width}`, { tag: "@visual" }, async ({ page }) => {
        await page.setViewportSize({
          width,
          height: width === 800 ? 550 : 800,
        });
        await page.addInitScript(
          ({ theme, view }) => {
            localStorage.removeItem("netamipin.demo.v2");
            localStorage.setItem("netamipin.theme", theme);
            localStorage.setItem("netamipin.view", view);
          },
          { theme, view },
        );
        await page.goto("/");
        await expect(page.locator("[data-bookmark-id]")).toHaveCount(6);
        await page.evaluate(() => document.fonts.ready);
        await expect(page).toHaveScreenshot(`${theme}-${view}-${width}.png`, {
          animations: "disabled",
          maxDiffPixelRatio: 0.002,
        });
      });
    }
  }
}
