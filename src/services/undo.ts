import type { TFunction } from "i18next";
import { Undo } from "../types";

/** A title in a notice: the notice stays one line. */
export const short = (title: string) => (title.length > 48 ? `${title.slice(0, 47)}…` : title);

/**
 * The notice after an undo (NP-024): what came back, or why nothing did.
 * A refusal is an alert: it stays until closed.
 */
export function undoNotice(t: TFunction, result: Undo): { text: string; alert: boolean } {
  if (result.outcome === "nothing") return { text: t("undo.nothing"), alert: false };
  if (result.outcome !== "undone") return { text: t(`undo.${result.outcome}`, { title: short(result.title) }), alert: true };
  // A bulk action (NP-029) comes back as a whole: the notice counts.
  const count = result.bookmarks.length;
  if (count > 1) {
    const many = result.action === "trash" ? "undo.undoneTrashMany" : result.action === "restore" ? "undo.undoneRestoreMany" : "undo.undoneMany";
    return { text: t(many, { count }), alert: false };
  }
  const title = short(result.bookmarks[0]?.title ?? "");
  const text =
    result.action === "trash"
      ? t("undo.undoneTrash", { title })
      : result.action === "restore"
        ? t("undo.undoneRestore", { title })
        : result.action === "finished"
          ? t("undo.undoneFinished", { title })
          : t("undo.undone", { title });
  return { text, alert: false };
}
