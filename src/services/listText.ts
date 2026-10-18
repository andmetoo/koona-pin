// The text of a `.kpin` list (NP-140, NP-141): what a built list holds, read back for the bundle
// panel, the same list as Markdown, and the checks of what an address may give away. Pure: no
// command, no storage.

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

/** What the builder wrote, read back; the text is the builder's, so it is trusted. */
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
