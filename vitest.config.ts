import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "extension/**/*.test.js", "supabase/**/*.test.ts", "scripts/lib/**/*.test.mjs"],
    environment: "node",
  },
});
