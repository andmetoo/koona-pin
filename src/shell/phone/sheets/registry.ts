import type { ComponentProps } from "react";
import { BookmarkMenu } from "./BookmarkMenu";
import { CollectionPicker } from "./CollectionPicker";
import { EditSheet } from "./EditSheet";
import { FeedMenuSheet } from "./FeedMenuSheet";
import { FinishSheet } from "./FinishSheet";
import { NewLinkSheet } from "./NewLinkSheet";
import { ReaderLookSheet } from "./ReaderLookSheet";
import { YouSheet } from "./YouSheet";
import { PlanSheet } from "../supporter/PlanSheet";
import { SignInSheet } from "../supporter/SignInSheet";
import { SupporterSheet } from "../supporter/SupporterSheet";

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
  /** "Aa" of the reader and the post view. */
  readerLook: ReaderLookSheet,
  /** "Mark as finished?": a tap on the reader's progress. */
  finishReading: FinishSheet,
  /** A feed chip's long-press menu. */
  feedMenu: FeedMenuSheet,
  /** Supporter: the perks, and the purchase where the build sells (`app.surface` "supporter"). */
  supporter: SupporterSheet,
  /** "I'm already a Supporter": the email and its code (`app.surface` "signIn"). */
  signIn: SignInSheet,
  /** A Supporter's plan (`app.surface` "plan"). */
  plan: PlanSheet,
};

export type SheetKind = keyof typeof SHEETS;
export type SheetPropsOf<K extends SheetKind> = ComponentProps<(typeof SHEETS)[K]>["props"];
/** What `useSheets().open` takes: a kind and its props. */
export type SheetRequest = { [K in SheetKind]: { kind: K; props: SheetPropsOf<K> } }[SheetKind];
