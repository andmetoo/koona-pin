import type { TFunction } from "i18next";
import { BulkChange } from "../types";
import { reasonOf } from "./errors";
import { short } from "./undo";

/**
 * The words of a bulk action (NP-029, frame 27): the notice after it and the
 * alert when it failed. `count` — bookmarks it applies to; `name` — the
 * collection a move goes to.
 */
export function bulkNotice(t: TFunction, change: BulkChange, count: number, name = ""): string {
  switch (change.action) {
    case "move":
      return change.collection_id === null ? t("bulk.movedOut", { count }) : t("bulk.moved", { count, name: short(name) });
    case "new_collection":
      return t("bulk.moved", { count, name: short(change.name) });
    case "tag":
      return t("bulk.tagged", { count, tag: short(change.name) });
    case "favorite":
      return t(change.favorite ? "bulk.starred" : "bulk.unstarred", { count });
    case "trash":
      return t("bulk.trashed", { count });
    case "restore":
      return t("bulk.restored", { count });
  }
}

/** «Не удалось переместить 4 закладки в «Работа»: библиотека занята. Ничего не изменено.» */
export function bulkFailure(t: TFunction, change: BulkChange, count: number, error: unknown, name = ""): string {
  const reason = reasonOf(error, t);
  switch (change.action) {
    case "move":
      return change.collection_id === null
        ? t("bulk.failed.moveOut", { count, reason })
        : t("bulk.failed.move", { count, name: short(name), reason });
    case "new_collection":
      return t("bulk.failed.newCollection", { name: short(change.name), reason });
    case "tag":
      return t("bulk.failed.tag", { count, tag: short(change.name), reason });
    case "favorite":
      return t(change.favorite ? "bulk.failed.star" : "bulk.failed.unstar", { count, reason });
    case "trash":
      return t("bulk.failed.trash", { count, reason });
    case "restore":
      return t("bulk.failed.restore", { count, reason });
  }
}
