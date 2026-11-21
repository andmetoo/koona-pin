import { defineConfig } from "vitest/config";

const jsdomFiles = [
  "extension/src/search.test.js",
  "src/hooks/useLibrary.test.ts",
  "src/hooks/usePicture.test.ts",
  "src/hooks/useReadingProgress.test.ts",
  "src/platform/useBack.test.ts",
  "src/services/articlePictures.test.ts",
  "src/services/feedsView.test.ts",
  "src/services/offline.test.ts",
  "src/services/reader.test.ts",
];

const nodeIsolatedFiles = [
  "src/components/bundle/actions.test.ts",
  "src/platform/haptics.test.ts",
  "src/platform/bridge.test.ts",
  "src/services/pictures.test.ts",
  "supabase/**/*.test.ts",
];

export default defineConfig({
  test: {
    // Worker threads, not forks: since Vitest 5.1 the forks pool calls `child.channel.unref()`,
    // which Bun's child_process does not have (Bun 1.4.4), and every fork fails to start.
    pool: "threads",
    projects: [
      {
        test: {
          name: "node-fast",
          include: ["src/**/*.test.ts", "extension/**/*.test.js"],
          exclude: [...jsdomFiles, ...nodeIsolatedFiles],
          environment: "node",
          isolate: false,
          pool: "threads",
        },
      },
      {
        test: {
          name: "node-isolated",
          include: nodeIsolatedFiles,
          environment: "node",
          isolate: true,
          pool: "threads",
        },
      },
      {
        test: {
          name: "jsdom",
          include: jsdomFiles,
          environment: "jsdom",
          isolate: true,
          pool: "threads",
        },
      },
    ],
  },
});
