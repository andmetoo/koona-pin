import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "extension/**/*.test.js", "supabase/**/*.test.ts"],
    environment: "node",
    // Worker threads, not forks: since Vitest 5.1 the forks pool calls `child.channel.unref()`,
    // which Bun's child_process does not have (Bun 1.4.4), and every fork fails to start.
    pool: "threads",
  },
});
