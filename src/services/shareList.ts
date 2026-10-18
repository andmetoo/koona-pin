// «Share as list…» (NP-140, NP-141, frame K2): the calls of src-tauri/src/lists/export.rs, the
// browser preview's stand-in for them, and the pure helpers of the dialog: what the built text
// holds, as the preview shows it, and the same list as Markdown.
import { invoke } from "@tauri-apps/api/core";
import type { ListBuildOptions } from "../bindings/ListBuildOptions";
import type { ListSource } from "../bindings/ListSource";
import type { ExportOutcome } from "../types";
import { api, desktopOnly, isTauri } from "./api";
import { CommandError, toCommandError } from "./errors";

export type { ListBuildOptions, ListSource };

/** The reader's limits (`lists/format.rs`): a bigger list cannot be saved. */
export const MAX_ITEMS = 5_000;
export const MAX_SECTIONS = 200;
export const MAX_BYTES = 2 * 1024 * 1024;

/** One item of the list as the file has it. */
export type DraftItem =
  | { type: "link"; url: string; title?: string; description?: string; tags?: string[] }
  | { type: "feed"; url: string; site?: string; title?: string };

/** The built text read back for the preview: the top level first, then the sections. */
export interface ListDraft {
  title: string;
  description: string | null;
  id: string | null;
  groups: { name: string | null; items: DraftItem[] }[];
  links: number;
  feeds: number;
  sections: number;
  /** UTF-8, as the file is written. */
  bytes: number;
}

type ListFileJson = {
  title?: string;
  description?: string;
  id?: string;
  sections?: { name: string; items: DraftItem[] }[];
  items?: DraftItem[];
};

/** What `build_list` wrote, for the preview; the text is the builder's, so it is trusted. */
export function readDraft(text: string): ListDraft {
  const file = JSON.parse(text) as ListFileJson;
  const top = file.items ?? [];
  const sections = file.sections ?? [];
  const groups = [...(top.length ? [{ name: null, items: top }] : []), ...sections.map((s) => ({ name: s.name, items: s.items }))];
  const all = groups.flatMap((g) => g.items);
  return {
    title: file.title ?? "",
    description: file.description ?? null,
    id: file.id ?? null,
    groups,
    links: all.filter((i) => i.type === "link").length,
    feeds: all.filter((i) => i.type === "feed").length,
    sections: sections.length,
    bytes: new TextEncoder().encode(text).length,
  };
}

/** Why a draft cannot be saved; none when it can. */
export function draftProblem(draft: ListDraft): "title" | "empty" | "too_big" | null {
  if (!draft.title.trim()) return "title";
  if (draft.links + draft.feeds === 0) return "empty";
  if (draft.links + draft.feeds > MAX_ITEMS || draft.sections > MAX_SECTIONS || draft.bytes > MAX_BYTES) return "too_big";
  return null;
}

/** The list's `id` suggested from its title, as `export.rs` makes one: ASCII letters and digits, dashes. */
export function slugify(title: string): string {
  let slug = "";
  for (const c of title.trim().toLowerCase()) {
    if (/[a-z0-9]/.test(c)) slug += c;
    else if (slug && !slug.endsWith("-")) slug += "-";
  }
  return slug.slice(0, 64).replace(/-+$/, "");
}

/** The name Save offers. */
export const fileName = (id: string) => `${slugify(id) || "list"}.kpin`;

/** Today on this computer, `YYYY-MM-DD`. */
export function today(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * Text in Markdown that cannot open a link, code, HTML or an escape: `\ ` [ ] ( ) < >` get a
 * backslash.
 */
export const escapeMarkdown = (text: string) => text.replace(/[\\`[\]()<>*_]/g, "\\$&");

/**
 * Lines of prose that stay prose: escaped as {@link escapeMarkdown}, and a line that would
 * start a heading, a list, a quote or a numbered item (`#`, `-`, `+`, `*`, `>`, `1.`) is escaped
 * at its start.
 */
export const escapeProse = (text: string) =>
  text
    .split("\n")
    .map((line) => escapeMarkdown(line).replace(/^(\s*)([#+*-])/, "$1\\$2").replace(/^(\s*)(\d+)\./, "$1$2\\."))
    .join("\n");

/** An address without a user name or password (`user:pass@`): they may be private. */
export function publicUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

/** An address inside `(…)`: what would end it early, spaces and `\` are percent-encoded. */
export const markdownUrl = (url: string) =>
  publicUrl(url).replace(/[()<>\\\s]/g, (c) => ({ "(": "%28", ")": "%29", "<": "%3C", ">": "%3E", "\\": "%5C" })[c] ?? encodeURIComponent(c));

/** Words of a query parameter's name that often mean its value is a key: the preview warns, the list still holds them. */
const PRIVATE_WORDS = new Set(["token", "key", "apikey", "secret", "auth", "password", "passwd", "sig", "signature", "session"]);

/** A parameter's name in words: `access_token`, `feed-token`, `apiKey` → access/token, feed/token, api/key. */
const wordsOf = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** The address has a query parameter named like a key or a token (`?token=…`, `&access_token=…`, `?feed_token=…`, `&apiKey=…`). */
export function mayHoldKey(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return [...new URL(url).searchParams.keys()].some((name) => wordsOf(name).some((word) => PRIVATE_WORDS.has(word)));
  } catch {
    return false;
  }
}

/** Items whose address or site may hold a key. */
export const itemHoldsKey = (item: DraftItem) => mayHoldKey(item.url) || (item.type === "feed" && mayHoldKey(item.site));

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

export const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/**
 * Copy as Markdown (NP-141): a heading, the description, then `- [title](url) — description`
 * grouped under section headings, the top level first. A feed links its site, then the feed
 * itself under `feedWord` («feed»).
 */
export function listMarkdown(draft: ListDraft, feedWord: string): string {
  const lines: string[] = [`# ${escapeMarkdown(oneLine(draft.title))}`, ""];
  if (draft.description) lines.push(escapeProse(draft.description.trim()), "");
  for (const group of draft.groups) {
    if (group.name !== null) lines.push(`## ${escapeMarkdown(oneLine(group.name))}`, "");
    for (const item of group.items) {
      const title = escapeMarkdown(oneLine(item.title || hostOf(item.url)));
      if (item.type === "feed") {
        lines.push(
          item.site
            ? `- [${title}](${markdownUrl(item.site)}) · [${escapeMarkdown(feedWord)}](${markdownUrl(item.url)})`
            : `- [${title}](${markdownUrl(item.url)})`,
        );
      } else {
        const description = item.description ? ` — ${escapeProse(oneLine(item.description))}` : "";
        lines.push(`- [${title}](${markdownUrl(item.url)})${description}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}

// The browser preview's stand-in for `export.rs`, which has no Rust behind it. It follows the
// cheap rules (http(s) only, no user names in addresses, tags cleaned and once, the caps, feeds
// once, sections and their names) so the preview looks like the app; it guarantees nothing.
// What a list may hold is guaranteed by the Rust tests of `lists/export.rs`.
const line = (text: string | null | undefined, max: number) => oneLine(text ?? "").slice(0, max).trimEnd();
const paragraph = (text: string | null | undefined, max: number) => (text ?? "").trim().slice(0, max).trimEnd();
const isWeb = (url: string) => /^https?:\/\/[^/?#\s]+/i.test(url.trim()) && url.trim().length <= 2048;

async function demoBuild(options: ListBuildOptions): Promise<string> {
  const [page, collections, feeds] = await Promise.all([api.getBookmarks({}, { limit: 100_000 }), api.getCollections(), api.listFeeds()]);
  const seen = new Set<string>();
  const chosen = options.sources.flatMap((source) => {
    if (source.kind === "feeds") return [];
    const ids = source.kind === "bookmarks" ? new Set(source.ids) : null;
    const collection = source.kind === "collection" ? source.id : null;
    return page.items.filter((b) => !b.deleted_at && (ids ? ids.has(b.id) : b.collection_id === collection));
  });
  const links = chosen.filter((b) => isWeb(b.url) && !seen.has(publicUrl(b.url.trim())) && !!seen.add(publicUrl(b.url.trim())));
  const top: DraftItem[] = [];
  const sections = new Map<string, DraftItem[]>();
  const keyed: [string, number, DraftItem][] = [];
  const order = collections.map((c) => c.id);
  const feedSources = options.sources.filter((s) => s.kind === "feeds");
  const all = feedSources.some((s) => !s.uids);
  const uids = new Set(feedSources.flatMap((s) => s.uids ?? []));
  const feedUrls = new Set<string>();
  const listed = feedSources.length
    ? feeds.filter((f) => (all || uids.has(f.uid)) && isWeb(f.url) && !feedUrls.has(f.url) && !!feedUrls.add(f.url))
    : [];
  const feedsName = line(options.feeds_section, 120) || "Feeds";
  const apart = (name: string) =>
    listed.length && name.toLowerCase() === feedsName.toLowerCase() ? line(`${name} · ${line(options.links_word, 120) || "links"}`, 120) : name;
  for (const b of links) {
    const tags = [...new Set((b.tags ?? []).map((t) => line(t.toLowerCase(), 64)).filter(Boolean))].sort();
    const note = options.notes ? paragraph(b.notes, 2000) : "";
    const description = note || (options.titles ? paragraph(b.description, 2000) : "");
    const title = options.titles ? line(b.title, 500) : "";
    const item: DraftItem = {
      type: "link",
      url: publicUrl(b.url.trim()),
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(options.tags && tags.length ? { tags: tags.slice(0, 20) } : {}),
    };
    const collection = collections.find((c) => c.id === b.collection_id);
    // As export.rs: only tags the person shares become sections.
    const section = line(options.sections === "by_tag" ? (options.tags ? tags[0] : "") : options.sections === "by_collection" ? collection?.name : "", 120);
    if (!section) top.push(item);
    else keyed.push([section, options.sections === "by_collection" ? order.indexOf(collection!.id) : 0, item]);
  }
  keyed.sort((a, b) => (options.sections === "by_tag" ? (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) : a[1] - b[1]));
  for (const [name, , item] of keyed) sections.set(apart(name), [...(sections.get(apart(name)) ?? []), item]);
  if (listed.length) {
    sections.set(feedsName, [
      ...(sections.get(feedsName) ?? []),
      ...listed.map((f): DraftItem => {
        const title = line(f.title ?? f.feed_title, 500);
        const site = f.site_url && isWeb(f.site_url) ? publicUrl(f.site_url) : "";
        return { type: "feed", url: publicUrl(f.url), ...(site ? { site } : {}), ...(options.titles && title ? { title } : {}) };
      }),
    ]);
  }
  const license = options.license === "cc0" ? "CC0-1.0" : options.license === "cc_by" ? "CC-BY-4.0" : undefined;
  const author = {
    ...(line(options.author_name, 120) ? { name: line(options.author_name, 120) } : {}),
    ...(isWeb(options.author_url) ? { url: publicUrl(options.author_url.trim()) } : {}),
  };
  const file = {
    format: "koona",
    app: "pin",
    kind: "list",
    version: "1.0",
    generator: "Koona Pin (browser preview)",
    ...(slugify(options.id) ? { id: slugify(options.id) } : {}),
    title: line(options.title, 120),
    ...(paragraph(options.description, 2000) ? { description: paragraph(options.description, 2000) } : {}),
    ...(Object.keys(author).length ? { author } : {}),
    ...(license ? { license } : {}),
    ...(options.language ? { language: options.language } : {}),
    ...(/^\d{4}-\d{2}-\d{2}$/.test(options.updated) ? { updated: options.updated } : {}),
    ...(sections.size ? { sections: [...sections].map(([name, items]) => ({ name, items })) } : {}),
    items: top,
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

const call = <T>(command: string, args: Record<string, unknown>) =>
  invoke<T>(command, args).catch((error: unknown) => {
    throw toCommandError(error);
  });

/** The commands, replaceable in UI tests as `api`'s are. */
export const lists = {
  /** The list's text for these choices: the preview and what Save writes. */
  buildList: (options: ListBuildOptions): Promise<string> => (isTauri() ? call<string>("build_list", { options }) : demoBuild(options)),
  /**
   * The system Save dialog, then the file written as an export is. The browser preview answers
   * as if it were saved under the offered name; tests replace it for the other outcomes.
   */
  saveList: async (text: string, id: string): Promise<ExportOutcome> => {
    if (isTauri()) return call<ExportOutcome>("save_list", { text, id });
    const draft = readDraft(text);
    if (draftProblem(draft)) throw new CommandError("invalid_request", "This file isn't a Koona list");
    return { outcome: "saved", file_name: fileName(id), count: draft.links + draft.feeds };
  },
  /** «Show» after a save: the file in its folder, as after an export. */
  reveal: async (): Promise<void> => desktopOnly().revealExport(),
};
