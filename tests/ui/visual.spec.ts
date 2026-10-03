import { test, expect } from "@playwright/test";

for (const width of [800, 1200, 1600]) {
  for (const theme of ["light", "dark"]) {
    for (const view of ["grid", "list"]) {
      test(
        `editorial ${theme} ${view} ${width}`,
        { tag: "@visual" },
        async ({ page }) => {
          await page.setViewportSize({
            width,
            height: width === 800 ? 550 : 800,
          });
          await page.addInitScript(
            ({ theme, view }) => {
              localStorage.removeItem("oddclicks.demo.v1");
              localStorage.setItem("oddclicks.theme", theme);
              localStorage.setItem("oddclicks.view", view);
            },
            { theme, view },
          );
          await page.goto("/");
          await expect(page.locator("[data-bookmark-id]")).toHaveCount(6);
          await expect(page).toHaveScreenshot(
            `${theme}-${view}-${width}.png`,
            {
              animations: "disabled",
              maxDiffPixelRatio: 0.002,
            },
          );
        },
      );
    }
  }
}
