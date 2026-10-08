import { defineConfig } from "@playwright/test";
export default defineConfig({
  forbidOnly: !!process.env.CI,
  testDir: "./tests/ui",
  use: {
    baseURL: "http://127.0.0.1:1420",
    viewport: { width: 1200, height: 800 },
    // English first: the app starts in English and the tests name controls in it (NP-085).
    locale: "en-US",
  },
  webServer: {
    command: "bun node_modules/vite/bin/vite.js --host 127.0.0.1",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: true,
  },
  reporter: "list",
});
