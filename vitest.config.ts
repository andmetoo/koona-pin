import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "extension/**/*.test.js", "supabase/functions/**/*.test.ts"],
    environment: "node",
  },
});
