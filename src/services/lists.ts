// The list dialog's rules (NP-138, kpin-lists.md «Import»), kept apart from the component so they
// are tested on their own: what the person chose, what the footer counts, and the words of a
// refusal or a failed download.
import type { ExistingLinks } from "../bindings/ExistingLinks";
import type { ListCheck } from "../bindings/ListCheck";
import type { ListDownload } from "../bindings/ListDownload";
import type { ListImportOptions } from "../bindings/ListImportOptions";
import type { ListPreview } from "../bindings/ListPreview";

/** «Put links into»: the list's own collection (new, or reused by name), one picked, or none. */
export type Destination = { kind: "list" } | { kind: "existing"; id: number } | { kind: "none" };

/** What the person chose in the preview (K1). */
export type ListChoices = {
  destination: Destination;
  toInbox: boolean;
  sectionsAsTags: boolean;
  existing: ExistingLinks;
  follow: boolean;
  /** The new feeds' addresses that stay checked. */
  feeds: string[];
};

/** The defaults of the plan: the list's collection, sorted, sections as tags, links left, every feed followed. */
export const defaultChoices = (preview: ListPreview): ListChoices => ({
  destination: { kind: "list" },
  toInbox: false,
  sectionsAsTags: true,
  existing: "leave",
  follow: true,
  feeds: preview.new_feeds.map((feed) => feed.url),
});

/** Feeds that will be followed. */
export const feedsChosen = (choices: ListChoices) => (choices.follow ? choices.feeds.length : 0);

/** What the footer's button counts: the links that are new and the feeds that will be followed. */
export const importCounts = (preview: ListPreview, choices: ListChoices) => ({ links: preview.new_links, feeds: feedsChosen(choices) });

/**
 * Nothing in the list can change the library: no new link or feed, and no saved link that could
 * get the list's tags. «Nothing new in this list» (K3).
 */
export const nothingNew = (preview: ListPreview) => preview.new_links === 0 && preview.new_feeds.length === 0 && preview.already_saved === 0;

/** The footer's main button: import what is new, only tag the links already saved, or close. */
export type FooterAction = { kind: "import"; links: number; feeds: number } | { kind: "tags"; links: number } | { kind: "close" };

export function footerAction(preview: ListPreview, choices: ListChoices): FooterAction {
  const { links, feeds } = importCounts(preview, choices);
  if (links > 0 || feeds > 0) return { kind: "import", links, feeds };
  if (choices.existing === "add_tags" && preview.already_saved > 0) return { kind: "tags", links: preview.already_saved };
  // Nothing would be imported: the button turns into Close, and the counts say why (the plan).
  return { kind: "close" };
}

/** The options of `import_list`. The list's collection is reused by name when one exists (Р-29). */
export function importOptions(preview: ListPreview, choices: ListChoices): ListImportOptions {
  const { destination } = choices;
  return {
    collection:
      destination.kind === "existing"
        ? { kind: "existing", id: destination.id }
        : destination.kind === "none"
          ? { kind: "none" }
          : preview.existing_collection
            ? { kind: "existing", id: preview.existing_collection.id }
            : { kind: "new", name: preview.meta.title },
    to_inbox: choices.toInbox,
    sections_as_tags: choices.sectionsAsTags,
    existing_links: choices.existing,
    follow_feeds: choices.follow ? preview.new_feeds.map((feed) => feed.url).filter((url) => choices.feeds.includes(url)) : [],
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
