import type { SkipReason, SkippedLink } from "../types";

/**
 * A browser bookmarks file read by the interface: the preview of the import
 * dialog (frame 28) and the demo adapter. The desktop import itself is
 * `import.rs`; the rule here is the same (Р-10 point 4) and is checked on the
 * same files of Chrome, Edge and Firefox. Folders are nested collections down
 * to `MAX_DEPTH` levels (2.19.0); the names of deeper ones become tags.
 */
/** As `db::MAX_DEPTH` in the desktop app. */
const MAX_DEPTH = 3;

export type ParsedLink = {
  url: string;
  title: string;
  /** The collections it sits in, outermost first, at most `MAX_DEPTH`; empty: none. */
  path: string[];
  tags: string[];
  /** When the browser saved it (`ADD_DATE`), in the library's format. */
  addedAt: string | null;
};
export type ParsedFile = {
  links: ParsedLink[];
  skipped: SkippedLink[];
  /** The user's folders: those that become a collection or a tag. */
  folders: number;
};

type Folder = { name: string; toolbar: boolean; unfiled: boolean };
type RawLink = { href: string; title: string; path: Folder[]; tags: string[]; addDate: string | null };

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return entities[name.toLowerCase()] ?? whole;
  });
const clean = (text: string) => decode(text.replace(/<[^>]*>/g, "")).split(/\s+/).filter(Boolean).join(" ");

function attributes(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const m of raw.matchAll(/([a-z_:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi))
    result[m[1].toLowerCase()] = decode(m[3] ?? m[4] ?? m[5] ?? "");
  return result;
}

const flag = (attrs: Record<string, string>, name: string) => attrs[name]?.toLowerCase() === "true";

/** An address as it would be saved, or why it is not. */
function classify(href: string): string | SkipReason {
  const address = href.trim();
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return "invalid";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "not_web";
  return url.hostname && address.length <= 8192 ? address : "invalid";
}

/** `ADD_DATE`: Unix seconds from browsers; milliseconds, microseconds or ISO from other tools. */
export function parseTime(raw: string, now = new Date()): string | null {
  const value = raw.trim();
  let time: number;
  if (/^-?\d+$/.test(value)) {
    const n = Number(value);
    time = n >= 1e14 ? Math.floor(n / 1000) : n >= 1e11 ? n : n * 1000;
  } else if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    time = Date.parse(value);
  } else return null;
  if (!Number.isFinite(time) || time < Date.UTC(1990, 0, 1) || time > now.getTime() + 86_400_000) return null;
  return new Date(time).toISOString();
}

export function parseBookmarksFile(html: string, now = new Date()): ParsedFile {
  const raw: RawLink[] = [];
  const roots: Folder[] = [];
  const path: Folder[] = [];
  /** Every `DL` pushes whether it opened a folder, so its `</DL>` knows what to close. */
  const opened: boolean[] = [];
  let pending: Folder | null = null;
  const tokens = /<(\/?)(dl|h3|a)\b([^>]*)>([\s\S]*?)(?=<\/?(?:dl|dt|dd|h3|a|p)\b|$)/gi;
  for (const m of html.matchAll(tokens)) {
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    if (tag === "dl") {
      if (closing) {
        if (opened.pop()) path.pop();
      } else {
        opened.push(pending !== null);
        if (pending) {
          if (path.length === 0) roots.push(pending);
          path.push(pending);
        }
        pending = null;
      }
    } else if (!closing && tag === "h3") {
      const attrs = attributes(m[3]);
      pending = { name: clean(m[4]), toolbar: flag(attrs, "personal_toolbar_folder"), unfiled: flag(attrs, "unfiled_bookmarks_folder") };
    } else if (!closing && tag === "a") {
      const attrs = attributes(m[3]);
      if (attrs.href !== undefined)
        raw.push({
          href: attrs.href,
          title: clean(m[4]),
          path: [...path],
          tags: attrs.tags ? attrs.tags.split(",") : [],
          addDate: attrs.add_date ?? null,
        });
    }
  }

  const firefox = roots.some((f) => f.unfiled);
  const chrome = !firefox && roots.some((f) => f.toolbar);
  const isRoot = (f: Folder, depth: number) => (firefox ? f.toolbar || f.unfiled : chrome && depth === 0);
  const seen = new Set<string>();
  const folders = new Set<string>();
  const result: ParsedFile = { links: [], skipped: [], folders: 0 };
  for (const link of raw) {
    const url = classify(link.href);
    if (url === "not_web" || url === "invalid") {
      result.skipped.push({ address: link.href.trim(), reason: url });
      continue;
    }
    if (seen.has(url)) {
      result.skipped.push({ address: url, reason: "repeated" });
      continue;
    }
    seen.add(url);
    const own: string[] = [];
    link.path.forEach((f, depth) => {
      if (isRoot(f, depth) || !f.name.trim()) return;
      own.push(f.name.trim());
      folders.add(own.join("\u0000"));
    });
    const path = own.slice(0, MAX_DEPTH);
    const tags = [...new Set([...own.slice(MAX_DEPTH), ...link.tags].map((t) => t.trim().toLowerCase()).filter(Boolean))];
    result.links.push({ url, title: link.title, path, tags, addedAt: link.addDate ? parseTime(link.addDate, now) : null });
  }
  result.folders = folders.size;
  return result;
}
