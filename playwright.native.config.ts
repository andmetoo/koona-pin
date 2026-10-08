import { defineConfig } from "@playwright/test";
// The app under test embeds its interface (scripts/build-test-app.mjs, run by bun before
// test:native and test:perf): no dev server.
export default defineConfig({
  forbidOnly: !!process.env.CI,
  testDir: "./tests/native",
  workers: 1,
  timeout: 45000,
  reporter: "list",
});
