import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    rollupOptions: {
      input: { app: "index.html", concept: "concept.html" },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: [
        "**/src-tauri/**",
        "**/.test-data/**",
        "**/.cache/**",
        "**/test-results/**",
        "**/doc/concepts/**",
      ],
    },
  },
});
