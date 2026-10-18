import { defineConfig } from "@playwright/test";
export default defineConfig({
  forbidOnly: !!process.env.CI,
  use: {
    baseURL: "http://127.0.0.1:1420",
    viewport: { width: 1200, height: 800 },
    // English first: the app starts in English and the tests name controls in it (NP-085).
    locale: "en-US",
  },
  projects: [
    {
      name: "desktop",
      testDir: "./tests/ui",
      // The screenshots keep their names without the project's.
      snapshotPathTemplate: "{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-snapshotSuffix}{ext}",
    },
    // The phone shell in the demo (NP-072b): tests/phone/fixtures.ts makes the page a phone.
    { name: "phone", testDir: "./tests/phone" },
  ],
  webServer: {
    command: "bun node_modules/vite/bin/vite.js --host 127.0.0.1",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: true,
  },
  reporter: "list",
});
