// The IPC contract is generated from Rust by ts-rs into src/bindings during
// `cargo test` (NP-007); do not describe these types by hand. Only types that
// exist in the interface alone are declared here.
export type { AddedLink } from "./bindings/AddedLink";
export type { AppSettings } from "./bindings/AppSettings";
export type { ImportSummary } from "./bindings/ImportSummary";
export type { ImportProgress } from "./bindings/ImportProgress";
export type { SkipReason } from "./bindings/SkipReason";
export type { SkippedLink } from "./bindings/SkippedLink";
export type { Bookmark } from "./bindings/Bookmark";
export type { BookmarkChange } from "./bindings/BookmarkChange";
export type { BookmarkPage } from "./bindings/BookmarkPage";
export type { BookmarkPatch } from "./bindings/BookmarkPatch";
export type { BookmarkQuery } from "./bindings/BookmarkQuery";
export type { Changed } from "./bindings/Changed";
export type { CommandAction } from "./bindings/CommandAction";
export type { Undo } from "./bindings/Undo";
export type { Suggestion } from "./bindings/Suggestion";
export type { PageCursor } from "./bindings/PageCursor";
export type { Collection } from "./bindings/Collection";
export type { CommandError as CommandErrorData } from "./bindings/CommandError";
export type { DataSummary } from "./bindings/DataSummary";
export type { DomainCount } from "./bindings/DomainCount";
export type { ErrorCode } from "./bindings/ErrorCode";
export type { LibraryCounts } from "./bindings/LibraryCounts";
export type { LibraryPlace } from "./bindings/LibraryPlace";
export type { LibraryStatus } from "./bindings/LibraryStatus";
export type { OpenCode } from "./bindings/OpenCode";
export type { OpenFailure } from "./bindings/OpenFailure";
export type { Tag } from "./bindings/Tag";
export type { Browser } from "./bindings/Browser";
export type { BrowserStatus } from "./bindings/BrowserStatus";
export type { CaptureProblem } from "./bindings/CaptureProblem";
export type { CaptureState } from "./bindings/CaptureState";
export type { CaptureStatus } from "./bindings/CaptureStatus";
export type { LastCapture } from "./bindings/LastCapture";

export type ViewMode = "grid" | "list";

export interface FilterState {
  search: string;
  collectionId: number | null;
  tag: string | null;
  domain: string | null;
  onlyFavorites: boolean;
  /** The «Inbox» section: bookmarks not sorted yet (NP-021). */
  onlyInbox: boolean;
  /** The «Trash» section (NP-022); every other section leaves the trash out. */
  onlyTrash: boolean;
}
