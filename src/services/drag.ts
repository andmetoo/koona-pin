import type { TFunction } from "i18next";
import { Collection } from "../types";
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
