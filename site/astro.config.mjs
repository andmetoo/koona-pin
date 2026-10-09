// koona.app/pin on Astro (NP-115, doc/site.md): static pages under /pin, no scripts, addresses as
// before — `preserve` keeps privacy.html, feedback/index.html, de/index.html where Caddy looks for
// them (site/Caddyfile). Stylesheet, fonts and images of the pages get a hash in their name under
// /pin/_astro/; scripts/build-site.mjs adds what Astro does not build: releases, Firefox updates and
// the screenshots at their lasting addresses.
import { defineConfig } from "astro/config";
import path from "node:path";
import { publish, root } from "../scripts/lib/paths.mjs";

export default defineConfig({
  root: import.meta.dirname,
  site: "https://koona.app",
  base: "/pin",
  outDir: publish.site,
  // No site/public: every file of the site is either built or put in by build-site.mjs.
  trailingSlash: "ignore",
  // Whitespace stays as written: inline elements keep the spaces the templates give them.
  compressHTML: false,
  devToolbar: { enabled: false },
  build: { format: "preserve", inlineStylesheets: "never" },
  vite: {
    // The CSP allows only own files: no data: URIs for small images or fonts.
    build: { assetsInlineLimit: 0 },
    // scripts/lib/paths.mjs, bundled into the pages, finds release/ from here (the releases, Firefox).
    define: { "import.meta.env.KOONAPIN_ROOT": JSON.stringify(root) },
    resolve: { alias: { "@inter": path.join(root, "node_modules/@fontsource-variable/inter/files") } },
    // Brand files live in design/brand and src-tauri/icons, outside the site folder.
    server: { fs: { allow: [root] } },
  },
});
