import { useLayoutEffect, useRef } from "react";
import { ArrowDownToLine, createLucideIcon, Plus } from "lucide-react";
import { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { DraggedFile, refusedByName } from "../../services/openRequests";
import { Icon } from "../icons";

/** The «!» of a refusal, as `Icon !` in K9b: Lucide's circle-alert without its circle. */
const Exclaim = createLucideIcon("Exclaim", [
  ["path", { d: "M12 4v11", key: "bar" }],
  ["path", { d: "M12 19.5h.01", key: "dot" }],
]);

/** What is dragged over the window: a link, with the line App words for it, or a file. */
export type DropZoneState = { link: true; hint: string } | { link?: false; file: DraggedFile; busy: boolean };

type Variant = "link" | "hero" | "kind" | "refused" | "busy";

/**
 * The zone's words (share-bundle.md, «Drop zone (K9)»), at most three lines: the hero for a file
 * of unknown kind (K9a), a kind or a refusal the webview let be known by name (K9b), another
 * import open; a link keeps its own lines.
 */
export function dropZoneText(state: DropZoneState, t: TFunction): { variant: Variant; title: string; line?: string; hint?: string } {
  if (state.link) return { variant: "link", title: t("add.dropTitle"), line: state.hint };
  const { file } = state;
  if (state.busy) return { variant: "busy", title: t("add.dropBusy") };
  if (refusedByName(file)) return { variant: "refused", title: t("add.dropImportNot"), line: t("add.dropImportOther") };
  if (file.kind) return { variant: "kind", title: t(`add.dropImportTitle_${file.kind}`), line: file.name ?? undefined, hint: t("add.dropConfirm") };
  return { variant: "hero", title: t("add.dropAnything"), line: t("add.dropAnythingLine"), hint: t("add.dropConfirm") };
}

/**
 * One full-window zone for whatever is dragged in from outside: a scrim, a dashed card 16 px in.
 * It lies in the top layer where the Popover API is there, so the «finish the open import» words
 * show over an open dialog too; it never takes the pointer.
 */
export function DropZone({ state }: { state: DropZoneState }) {
  const { t } = useTranslation();
  const zone = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = zone.current;
    if (element && typeof element.showPopover === "function" && !element.matches(":popover-open")) element.showPopover();
  }, []);
  const { variant, title, line, hint } = dropZoneText(state, t);
  const warn = variant === "busy" || variant === "refused";
  return (
    <div
      ref={zone}
      popover="manual"
      aria-hidden
      className="drop-zone"
      data-drop-zone={variant}
      data-warn={warn || undefined}
    >
      <div className="drop-zone-card">
        {/* A new variant cross-fades its words in (120 ms); the zone itself only fades. */}
        <div key={`${variant}:${title}`} className="drop-zone-words max-w-[min(520px,80vw)]">
          <span className="drop-zone-icon">
            <Icon icon={warn ? Exclaim : state.link ? Plus : ArrowDownToLine} size={22} strokeWidth={warn ? 2.5 : 1.5} />
          </span>
          <b className="block text-[22px] leading-7 font-semibold tracking-[-0.01em] text-ink">{title}</b>
          {line && <span className="mt-2 block text-[13px] text-muted [overflow-wrap:anywhere]">{line}</span>}
          {hint && <span className="mt-4 block text-xs text-muted">{hint}</span>}
        </div>
      </div>
    </div>
  );
}
