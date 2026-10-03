// The IPC contract is generated from Rust by ts-rs into src/bindings during
// `cargo test` (NP-007); do not describe these types by hand. Only types that
// exist in the interface alone are declared here.
import type { Bookmark as StoredBookmark } from "./bindings/Bookmark";

export type { AppSettings } from "./bindings/AppSettings";
export type { BookmarkChange } from "./bindings/BookmarkChange";
export type { BookmarkPatch } from "./bindings/BookmarkPatch";
export type { Collection } from "./bindings/Collection";
export type { CommandError as CommandErrorData } from "./bindings/CommandError";
export type { DomainCount } from "./bindings/DomainCount";
export type { ErrorCode } from "./bindings/ErrorCode";
export type { LibraryCounts } from "./bindings/LibraryCounts";
export type { LibraryPlace } from "./bindings/LibraryPlace";
export type { LibraryStatus } from "./bindings/LibraryStatus";
export type { OpenCode } from "./bindings/OpenCode";
export type { OpenFailure } from "./bindings/OpenFailure";
export type { ServerStatus } from "./bindings/ServerStatus";
export type { Tag } from "./bindings/Tag";

export type PreviewKind =
  | "rams"
  | "architecture"
  | "type"
  | "code"
  | "photo"
  | "article";

/** A stored bookmark; the demo adds drawn previews instead of images. */
export type Bookmark = StoredBookmark & { preview_kind?: PreviewKind };

export type ViewMode = "grid" | "list";

export interface FilterState {
  search: string;
  collectionId: number | null;
  tag: string | null;
  domain: string | null;
  onlyFavorites: boolean;
}
