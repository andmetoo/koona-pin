import type { TFunction } from "i18next";
import { Collection, Feed } from "../types";
import { short } from "./undo";

/**
 * Where the selection can be dropped (NP-030, frame 05, sheet 32): a
 * collection — move there; a tag — add it; «Корзина» — to the trash;
 * «Новая коллекция из выбранного» — create one and move there; Favorites
 * and Reading — star them, send them to Reading (the bar's same actions); the
 * bundle — add them to it (share-bundle.md, piece B).
 */
export type DropTarget =
  | { kind: "collection"; id: number }
  | { kind: "tag"; name: string }
  | { kind: "trash" }
  | { kind: "new" }
  | { kind: "favorites" }
  | { kind: "reading" }
  | { kind: "bundle" };

/** The `data-drop` of an element: `collection:12`, `tag:crypto`, `trash`, `new`, `favorites`, `reading`, `bundle`. */
export function dropAttribute(target: DropTarget): string {
  switch (target.kind) {
    case "collection":
      return `collection:${target.id}`;
    case "tag":
      return `tag:${target.name}`;
    default:
      return target.kind;
  }
}

/** The target an element under the pointer names; a tag may itself contain colons. */
export function parseDrop(value: string | undefined | null): DropTarget | null {
  if (!value) return null;
  if (value === "trash" || value === "new" || value === "favorites" || value === "reading" || value === "bundle") return { kind: value };
  const colon = value.indexOf(":");
  const kind = value.slice(0, colon);
  const rest = value.slice(colon + 1);
  if (kind === "tag" && rest) return { kind: "tag", name: rest };
  if (kind === "collection" && /^\d+$/.test(rest)) return { kind: "collection", id: Number(rest) };
  return null;
}

export const sameDrop = (a: DropTarget | null, b: DropTarget | null) =>
  a === b || (!!a && !!b && dropAttribute(a) === dropAttribute(b));

/**
 * The hint under the stack says what the drop will do — the same action the
 * bar would run (frame 27): «Переместить 3 в «Разработка»». Outside a target
 * it says where to drop.
 */
export function dropHint(t: TFunction, target: DropTarget | null, count: number, collections: Collection[]): string {
  if (!target) return t("drag.nowhere");
  switch (target.kind) {
    case "collection": {
      const name = collections.find((c) => c.id === target.id)?.name ?? "";
      return t("drag.move", { count, name: short(name) });
    }
    case "tag":
      return t("drag.tag", { count, tag: short(target.name) });
    case "trash":
      return t("drag.trash", { count });
    case "new":
      return t("drag.new", { count });
    case "favorites":
      return t("drag.favorites", { count });
    case "reading":
      return t("drag.reading", { count });
    case "bundle":
      return t("drag.bundle", { count });
  }
}

/**
 * A sidebar row dragged to the bundle (share-bundle.md, piece C): a collection, a tag chip, a feed
 * row or All feeds. Its only target is the bundle; sidebar targets refuse it.
 */
export type RowDragItem =
  | { kind: "collection"; collection: Collection }
  | { kind: "tag"; name: string; count: number }
  | { kind: "feeds"; label: string; feeds: Feed[] };

/** How many things the row brings: a collection's or a tag's links, the feeds. */
export const rowCount = (item: RowDragItem) =>
  item.kind === "collection" ? (item.collection.count ?? 0) : item.kind === "tag" ? item.count : item.feeds.length;

/** The row's line in its stack: «Development · 41 links». */
export function rowLine(t: TFunction, item: RowDragItem): string {
  const name = item.kind === "collection" ? item.collection.name : item.kind === "tag" ? item.name : item.label;
  return `${short(name)} · ${t(item.kind === "feeds" ? "drag.feeds" : "drag.links", { count: rowCount(item) })}`;
}

/** What the capsule says with the row over it: «Add collection “Development”», «Add 2 feeds». */
export function rowDropLabel(t: TFunction, item: RowDragItem): string {
  if (item.kind === "collection") return t("drag.bundleCollection", { name: short(item.collection.name) });
  if (item.kind === "tag") return t("drag.bundleTag", { name: short(item.name) });
  return t("drag.bundleFeeds", { count: item.feeds.length });
}

/** Room the drag stack keeps from the window's edges, and how far it moves to the pointer's other side. */
const STACK_EDGE = 8;
const STACK_FLIP = { x: 12, y: 32 };

/**
 * Puts a drag stack at the pointer. Where it would leave the window it goes to the pointer's other
 * side, so the card and the hint stay whole over the capsule in the bottom right corner; 32 px up
 * clears the capsule under the pointer.
 */
export function placeStack(stack: HTMLElement, x: number, y: number) {
  let width = 0;
  let height = 0;
  for (const child of Array.from(stack.children) as HTMLElement[]) {
    width = Math.max(width, child.offsetLeft + child.offsetWidth);
    height = Math.max(height, child.offsetTop + child.offsetHeight);
  }
  const left = x + width > innerWidth - STACK_EDGE ? Math.max(0, x - width - STACK_FLIP.x) : x;
  const top = y + height > innerHeight - STACK_EDGE ? Math.max(0, y - height - STACK_FLIP.y) : y;
  stack.style.transform = `translate(${left}px, ${top}px)`;
}
