import type { ComponentProps } from "react";
import { BookmarkMenu } from "./BookmarkMenu";
import { CollectionPicker } from "./CollectionPicker";
import { EditSheet } from "./EditSheet";
import { NewLinkSheet } from "./NewLinkSheet";
import { YouSheet } from "./YouSheet";

/**
 * Every kind of sheet the phone opens (NP-072b), by name. A sheet is a component taking
 * `{ props }` (its own props type, exported from its file) that renders a kit `Sheet`. A new kind
 * is one line here (the Fold rail's popover comes later).
 */
export const SHEETS = {
  /** B1: the bookmark of `app.editing`. */
  edit: EditSheet,
  /** C1. */
  collectionPicker: CollectionPicker,
  /** N1: "+" in the nav pill or the rail. */
  newLink: NewLinkSheet,
  /** A1: the account cluster. */
  you: YouSheet,
  /** A bookmark's long-press menu. */
  bookmarkMenu: BookmarkMenu,
};

export type SheetKind = keyof typeof SHEETS;
export type SheetPropsOf<K extends SheetKind> = ComponentProps<(typeof SHEETS)[K]>["props"];
/** What `useSheets().open` takes: a kind and its props. */
export type SheetRequest = { [K in SheetKind]: { kind: K; props: SheetPropsOf<K> } }[SheetKind];
