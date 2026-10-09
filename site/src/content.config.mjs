// Content collections (NP-115): pages in English only, written as Markdown.
//   changelog — site/content/changelog/<version>.md: `date` on top, then one «- » line per change.
// The same files feed the update dialog of the app (build-latest.mjs reads them with changelog.mjs).
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const changelog = defineCollection({
  loader: glob({ pattern: "*.md", base: "./content/changelog", generateId: ({ entry }) => entry.slice(0, -3) }),
  // YAML reads `date: 2026-10-09` as a date; the page shows it as written (UTC, no time).
  schema: z.object({ date: z.date().transform((d) => d.toISOString().slice(0, 10)) }),
});

export const collections = { changelog };
