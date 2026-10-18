// The list dialog's rules (NP-138, kpin-lists.md «Import»), kept apart from the component so they
// are tested on their own: what the person chose, what the footer counts, and the words of a
// refusal or a failed download.
import type { ListCheck } from "../bindings/ListCheck";
import type { ListDownload } from "../bindings/ListDownload";
import type { ListImportOptions } from "../bindings/ListImportOptions";
import type { ListPreview } from "../bindings/ListPreview";
import type { ListPreviewItem } from "../bindings/ListPreviewItem";

/**
 * «Put links into» (K10): the list's own collection (new, or reused by name), one picked, none,
 * or none and no tags from the sections either.
 */
export type Destination = { kind: "list" } | { kind: "existing"; id: number } | { kind: "none" } | { kind: "bare" };

/** What the person chose in the preview (K10). Links already saved are left as they are. */
export type ListChoices = {
  destination: Destination;
  toInbox: boolean;
  /** The new feeds' addresses that stay checked. */
  feeds: string[];
};

/** The defaults of the plan: the list's collection, sorted, every new feed followed. */
export const defaultChoices = (preview: ListPreview): ListChoices => ({
  destination: { kind: "list" },
  toInbox: false,
  feeds: preview.new_feeds.map((feed) => feed.url),
});

/** What Accept adds: the links that are new and the feeds that stay checked. */
export const importCounts = (preview: ListPreview, choices: ListChoices) => ({
  links: preview.new_links,
  feeds: preview.new_feeds.filter((feed) => choices.feeds.includes(feed.url)).length,
});

/**
 * Nothing in the list can change the library: no new link and no new feed. Saved links are left
 * as they are and links in the Trash stay there: «Everything in this list is already here» (K10b).
 */
export const nothingNew = (preview: ListPreview) => preview.new_links === 0 && preview.new_feeds.length === 0;

/** «Follow all» over some feeds: every one checked, none, or some. */
export type FollowAll = "on" | "off" | "mixed";

export function followAll(urls: string[], chosen: string[]): FollowAll {
  const on = urls.filter((url) => chosen.includes(url)).length;
  return on === 0 ? "off" : on === urls.length ? "on" : "mixed";
}

/** «Follow all» clicked: some or none checked become all, all become none. */
export function toggleAll(urls: string[], chosen: string[]): string[] {
  const rest = chosen.filter((url) => !urls.includes(url));
  return followAll(urls, chosen) === "on" ? rest : [...rest, ...urls];
}

/** A group of more rows than this folds (K10)… */
export const FOLD_OVER = 8;
/** …to this many, and «Show N more». */
export const FOLDED = 5;

/**
 * A row of the preview's one scrolling list (K10): the MINOR notice, a group's header, a link or a
 * feed, or a folded group's «Show N more». Headers are rows too, so one virtualiser holds them all.
 */
export type PreviewRow =
  | { kind: "notice" }
  | {
      kind: "group";
      group: number;
      name: string | null;
      tag: string | null;
      count: number;
      /** Only feeds: «Feeds» at the top level, and «Follow all» over `feeds`. */
      feedsOnly: boolean;
      /** The group's new feeds, which «Follow all» checks. */
      feeds: string[];
    }
  | { kind: "item"; group: number; item: ListPreviewItem }
  | { kind: "more"; group: number; count: number };

/**
 * The preview's rows. The top level has no header when it is the only group; a group of more than
 * `FOLD_OVER` rows shows `FOLDED` until it is in `open`.
 */
export function previewRows(preview: ListPreview, open: ReadonlySet<number>): PreviewRow[] {
  const rows: PreviewRow[] = preview.newer ? [{ kind: "notice" }] : [];
  const alone = preview.groups.length === 1;
  preview.groups.forEach((g, group) => {
    if (!(alone && g.name === null))
      rows.push({
        kind: "group",
        group,
        name: g.name,
        tag: g.tag,
        count: g.items.length,
        feedsOnly: g.items.every((item) => item.kind === "feed"),
        feeds: g.items.filter((item) => item.kind === "feed" && item.status === "new").map((item) => item.url),
      });
    const folded = g.items.length > FOLD_OVER && !open.has(group);
    for (const item of folded ? g.items.slice(0, FOLDED) : g.items) rows.push({ kind: "item", group, item });
    if (folded) rows.push({ kind: "more", group, count: g.items.length - FOLDED });
  });
  return rows;
}

/** The options of `import_list`. The list's collection is reused by name when one exists (Р-29). */
export function importOptions(preview: ListPreview, choices: ListChoices): ListImportOptions {
  const { destination } = choices;
  return {
    collection:
      destination.kind === "existing"
        ? { kind: "existing", id: destination.id }
        : destination.kind === "none" || destination.kind === "bare"
          ? { kind: "none" }
          : preview.existing_collection
            ? { kind: "existing", id: preview.existing_collection.id }
            : { kind: "new", name: preview.meta.title },
    to_inbox: choices.toInbox,
    sections_as_tags: destination.kind !== "bare",
    existing_links: "leave",
    follow_feeds: preview.new_feeds.map((feed) => feed.url).filter((url) => choices.feeds.includes(url)),
  };
}

/** A refusal of the list itself, as the dialog shows it (K3). */
export type Refusal = { state: "newer" } | { state: "otherApp"; app: string } | { state: "notList"; reason: "not_a_list" | "too_big" | "empty" | "unreadable" };

export function refusalOf(check: Exclude<ListCheck, { outcome: "ready" }>): Refusal {
  switch (check.outcome) {
    case "needs_newer_app":
      return { state: "newer" };
    case "other_app":
      return { state: "otherApp", app: check.app };
    default:
      return { state: "notList", reason: check.outcome };
  }
}

/** Another Koona app by its `app`: `note` is «Koona Note». Only letters and digits are shown. */
export function otherAppName(app: string) {
  const word = app.replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 24);
  return word ? `Koona ${word[0].toLocaleUpperCase()}${word.slice(1)}` : "Koona";
}

/** Why a download failed: a key under `lists.reason_`. */
export type DownloadReason = Exclude<ListDownload["outcome"], "done" | "cancelled" | "not_a_list">;

/** Why a download failed, with the status of an HTTP error; `null` when it did not fail. */
export function downloadFailure(outcome: ListDownload): { key: DownloadReason; status?: number } | null {
  switch (outcome.outcome) {
    case "done":
    case "cancelled":
    case "not_a_list":
      return null;
    case "status":
      return { key: "status", status: outcome.status };
    default:
      return { key: outcome.outcome };
  }
}

/** Where a list is downloaded from, for «Download a list from <host>?». */
export const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** The file a list address names, decoded, for «<host> · <file>»; empty for a bare host. */
export function fileOf(url: string) {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(last);
  } catch {
    return "";
  }
}

/** The downloaded share, 0 to 1, when the size is known. */
export const downloadShare = (received: number, total: number | null) => (total ? Math.min(1, received / total) : null);
