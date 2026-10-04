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
  const title = short(result.bookmarks[0]?.title ?? "");
  const text =
    result.action === "trash"
      ? t("undo.undoneTrash", { title })
      : result.action === "restore"
        ? t("undo.undoneRestore", { title })
        : t("undo.undone", { title });
  return { text, alert: false };
}
