// The bundle's commands (share-bundle.md, pieces A and B): `build_bundle_list` turns what the bundle
// holds into the text of a `.kpin` list, `save_list` writes it through the system Save dialog. This
// is the one place the bundle talks to Rust; the browser preview gets a stand-in for the builder.
import { invoke } from "@tauri-apps/api/core";
import type { BundleBuild } from "../bindings/BundleBuild";
import type { BundleItem } from "../bindings/BundleItem";
import type { BundleModel } from "../bindings/BundleModel";
import type { BundleOrigin } from "../bindings/BundleOrigin";
import type { ExportOutcome } from "../types";
import { api, desktopOnly, isTauri } from "./api";
import { CommandError, toCommandError } from "./errors";
import { DraftItem, MAX_BYTES, MAX_ITEMS, MAX_SECTIONS, draftProblem, fileName, publicUrl, readDraft, slugify } from "./listText";

export type { BundleBuild, BundleItem, BundleModel, BundleOrigin };

// The browser preview's stand-in for `lists::bundle`, which has no Rust behind it. It follows the
// cheap rules (Links as top-level items, the Feeds name, an address once, notes when asked, the
// caps) so the preview looks like the app; it guarantees nothing. The Rust tests do.
const oneLine = (text: string | null | undefined, max: number) => (text ?? "").replace(/\s+/g, " ").trim().slice(0, max).trimEnd();
const paragraph = (text: string | null | undefined, max: number) => (text ?? "").trim().slice(0, max).trimEnd();
const isWeb = (url: string) => /^https?:\/\/[^/?#\s]+/i.test(url.trim()) && url.trim().length <= 2048;
const today = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

async function demoBuild(model: BundleModel): Promise<BundleBuild> {
  const [page, collections, feeds] = await Promise.all([api.getBookmarks({}, { limit: 100_000 }), api.getCollections(), api.listFeeds()]);
  const live = new Map(page.items.filter((b) => !b.deleted_at).map((b) => [b.id, b]));
  const feedsBy = new Map(feeds.map((f) => [f.uid, f]));
  const seen = new Set<string>();
  let left = 0;
  const top: DraftItem[] = [];
  const sections: { name: string; items: DraftItem[] }[] = [];
  let feedSection: { name: string; items: DraftItem[] } | null = null;
  const feedsName = oneLine(model.feeds_section, 120) || "Feeds";
  for (const section of model.sections) {
    const items: DraftItem[] = [];
    for (const item of section.items) {
      if (item.kind === "bookmark") {
        const b = live.get(item.id);
        if (!b) {
          left++;
          continue;
        }
        const url = publicUrl(b.url.trim());
        if (!isWeb(url) || seen.has(url)) continue;
        seen.add(url);
        const tags = [...new Set((b.tags ?? []).map((t) => oneLine(t.toLowerCase(), 64)).filter(Boolean))].sort().slice(0, 20);
        const description = (item.use_note && paragraph(b.notes, 2000)) || paragraph(b.description, 2000);
        const title = oneLine(b.title, 500);
        items.push({ type: "link", url, ...(title ? { title } : {}), ...(description ? { description } : {}), ...(tags.length ? { tags } : {}) });
      } else {
        const f = feedsBy.get(item.uid);
        if (!f) {
          left++;
          continue;
        }
        const url = publicUrl(f.url);
        if (!isWeb(url) || seen.has(url)) continue;
        seen.add(url);
        const title = oneLine(f.title ?? f.feed_title, 500);
        const site = f.site_url && isWeb(f.site_url) ? publicUrl(f.site_url) : "";
        items.push({ type: "feed", url, ...(site ? { site } : {}), ...(title ? { title } : {}) });
      }
    }
    if (section.origin.kind === "links") top.push(...items);
    else if (items.length) {
      const origin = section.origin;
      const own = origin.kind === "collection" ? (collections.find((c) => c.id === origin.id)?.name ?? section.name) : origin.kind === "tag" ? origin.name : section.name;
      // A collection or a tag named as the feeds' section stays apart from it: «Feeds · links».
      const name = own.trim().toLowerCase() === feedsName.toLowerCase() ? `${own.trim()} · ${oneLine(model.links_word, 120) || "links"}` : own;
      // Feeds last, whatever the model's order.
      if (origin.kind === "feeds") feedSection = { name: feedsName, items };
      else sections.push({ name: oneLine(name, 120), items });
    }
  }
  if (feedSection) sections.push(feedSection);
  const title = oneLine(model.title, 120);
  const file = {
    format: "koona",
    app: "pin",
    kind: "list",
    version: "1.0",
    generator: "Koona Pin (browser preview)",
    ...(slugify(title) ? { id: slugify(title) } : {}),
    title,
    ...(paragraph(model.description, 2000) ? { description: paragraph(model.description, 2000) } : {}),
    ...(oneLine(model.author_name, 120) ? { author: { name: oneLine(model.author_name, 120) } } : {}),
    license: "CC0-1.0",
    language: document.documentElement.lang || "en",
    updated: today(),
    ...(sections.length ? { sections } : {}),
    items: top,
  };
  const text = `${JSON.stringify(file, null, 2)}\n`;
  const count = top.length + sections.reduce((sum, s) => sum + s.items.length, 0);
  const bytes = new TextEncoder().encode(text).length;
  if (count > MAX_ITEMS || sections.length > MAX_SECTIONS || bytes > MAX_BYTES) return { text: "", items: count, left, too_big: bytes };
  return { text, items: count, left, too_big: null };
}

const call = <T>(command: string, args: Record<string, unknown>) =>
  invoke<T>(command, args).catch((error: unknown) => {
    throw toCommandError(error);
  });

/** The commands, replaceable in UI tests as `api`'s are. */
export const bundleApi = {
  /** The list's text for what the bundle holds; past a limit, `too_big` gives its size and the text is empty. */
  build: (model: BundleModel): Promise<BundleBuild> => (isTauri() ? call<BundleBuild>("build_bundle_list", { model }) : demoBuild(model)),
  /**
   * The system Save dialog, then the file written as an export is; `name`, made from the title by
   * `titleFileName`, names the file, else `id`. The browser preview answers as if it were saved under that
   * name; tests replace it.
   */
  save: async (text: string, id: string, name?: string): Promise<ExportOutcome> => {
    if (isTauri()) return call<ExportOutcome>("save_list", { text, id, name: name ?? null });
    const draft = readDraft(text);
    if (draftProblem(draft)) throw new CommandError("invalid_request", "This file isn't a Koona list");
    return { outcome: "saved", file_name: name ?? fileName(id), count: draft.links + draft.feeds };
  },
  /** «Show» after a save: the file in its folder, as after an export; offered only with `capabilities.file_manager`. */
  reveal: async (): Promise<void> => desktopOnly().revealExport(),
};
