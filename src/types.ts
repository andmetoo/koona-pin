// The IPC contract is generated from Rust by ts-rs into src/bindings during
// `cargo test` (NP-007); do not describe these types by hand. Only types that
// exist in the interface alone are declared here.
export type { AddedLink } from "./bindings/AddedLink";
export type { AppSettings } from "./bindings/AppSettings";
export type { ImportSummary } from "./bindings/ImportSummary";
export type { ImportProgress } from "./bindings/ImportProgress";
export type { ExportFormat } from "./bindings/ExportFormat";
export type { ExportOutcome } from "./bindings/ExportOutcome";
export type { ExportProblem } from "./bindings/ExportProblem";
export type { CsvColumns } from "./bindings/CsvColumns";
export type { RestoreMode } from "./bindings/RestoreMode";
export type { RestorePreview } from "./bindings/RestorePreview";
export type { RestoreProblem } from "./bindings/RestoreProblem";
export type { RestoreSummary } from "./bindings/RestoreSummary";
export type { RestoreCheck } from "./bindings/RestoreCheck";
export type { RestoreOutcome } from "./bindings/RestoreOutcome";
export type { CopyItem } from "./bindings/CopyItem";
export type { Damage } from "./bindings/Damage";
export type { SkipReason } from "./bindings/SkipReason";
export type { SkippedLink } from "./bindings/SkippedLink";
export type { Bookmark } from "./bindings/Bookmark";
export type { BookmarkChange } from "./bindings/BookmarkChange";
export type { BookmarkPage } from "./bindings/BookmarkPage";
export type { BookmarkPatch } from "./bindings/BookmarkPatch";
export type { BookmarkQuery } from "./bindings/BookmarkQuery";
export type { BookmarkSort } from "./bindings/BookmarkSort";
export type { Changed } from "./bindings/Changed";
export type { BulkChange } from "./bindings/BulkChange";
export type { BulkChanged } from "./bindings/BulkChanged";
export type { CommandAction } from "./bindings/CommandAction";
export type { Undo } from "./bindings/Undo";
export type { Suggestion } from "./bindings/Suggestion";
export type { PageCursor } from "./bindings/PageCursor";
export type { Collection } from "./bindings/Collection";
export type { CommandError as CommandErrorData } from "./bindings/CommandError";
export type { DataSummary } from "./bindings/DataSummary";
export type { BackupCopy } from "./bindings/BackupCopy";
export type { BackupRestoreOutcome } from "./bindings/BackupRestoreOutcome";
export type { BackupSource } from "./bindings/BackupSource";
export type { CopyKind } from "./bindings/CopyKind";
export type { CopyProblem } from "./bindings/CopyProblem";
export type { PickedCopy } from "./bindings/PickedCopy";
export type { SaveCopyOutcome } from "./bindings/SaveCopyOutcome";
export type { DuplicateGroup } from "./bindings/DuplicateGroup";
export type { MergeGroup } from "./bindings/MergeGroup";
export type { Merged } from "./bindings/Merged";
export type { CheckedLink } from "./bindings/CheckedLink";
export type { LinkCheckProgress } from "./bindings/LinkCheckProgress";
export type { LinkCheckReport } from "./bindings/LinkCheckReport";
export type { LinkCheckState } from "./bindings/LinkCheckState";
export type { LinkFailure } from "./bindings/LinkFailure";
export type { Replaced } from "./bindings/Replaced";
export type { DomainCount } from "./bindings/DomainCount";
export type { ErrorCode } from "./bindings/ErrorCode";
export type { ErrorDetail } from "./bindings/ErrorDetail";
export type { TrayLabels } from "./bindings/TrayLabels";
export type { Desktop } from "./bindings/Desktop";
export type { WindowButton } from "./bindings/WindowButton";
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
export type { Feedback } from "./bindings/Feedback";
export type { FeedbackKind } from "./bindings/FeedbackKind";

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
