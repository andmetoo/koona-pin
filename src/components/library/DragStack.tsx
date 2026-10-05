import { RefObject, useLayoutEffect } from "react";
import { Folder, Plus, Tag as TagIcon, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Collection } from "../../types";
import { dropHint } from "../../services/drag";
import { SelectionDrag } from "../../hooks/useSelectionDrag";
import { Icon } from "../icons";
import { Preview } from "./Bookmarks";

const icons = { collection: Folder, tag: TagIcon, trash: Trash2, new: Plus };

/**
 * The stack under the pointer (frame 05, sheet 32): the bookmark the drag
 * started from, «и ещё N закладки», the count, and the hint of what the drop
 * will do. It lets the pointer through, so the sidebar sees what is under it;
 * `place` moves it without a render.
 */
export function DragStack({
  drag,
  collections,
  stack,
  place,
}: {
  drag: SelectionDrag;
  collections: Collection[];
  stack: RefObject<HTMLDivElement | null>;
  place: () => void;
}) {
  const { t } = useTranslation();
  useLayoutEffect(place);
  const { bookmark, count, target } = drag;
  const hint = dropHint(t, target, count, collections);
  const back = "absolute h-14 w-60 rounded-xl border border-border bg-card";
  return (
    <div ref={stack} data-drag-stack className="pointer-events-none fixed top-0 left-0 z-50" style={{ width: 260 }}>
      {count > 2 && <div aria-hidden className={`${back} top-5 left-4 opacity-70`} />}
      {count > 1 && <div aria-hidden className={`${back} top-[15px] left-3 opacity-85`} />}
      <div aria-hidden className="absolute top-2.5 left-2 flex h-14 w-60 items-center gap-2.5 rounded-xl border border-border bg-card px-2 shadow-[0_8px_20px_rgb(0_0_0/0.15)]">
        <span className="h-[38px] w-[52px] shrink-0 overflow-hidden rounded-[5px] bg-hover">
          <Preview b={bookmark} small />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-xs font-medium text-ink">{bookmark.title || bookmark.url}</span>
          <span className="truncate text-2xs text-subtle">{count > 1 ? t("drag.more", { count: count - 1 }) : bookmark.domain}</span>
        </span>
      </div>
      <span
        aria-hidden
        className="absolute top-0 left-[234px] flex h-[22px] min-w-[26px] items-center justify-center rounded-sm border-2 border-bg bg-accent px-1.5 text-xs font-bold text-on-accent"
      >
        {count}
      </span>
      {/* What the drop will do, read out as it changes. */}
      <span
        role="status"
        data-drop-hint
        className="absolute top-[76px] left-2 flex h-[26px] max-w-[320px] items-center gap-1.5 rounded-lg bg-toast px-2.5 text-xs whitespace-nowrap text-[#e9e6dc]"
      >
        {target && <Icon icon={icons[target.kind]} size={13} />}
        <span className={`truncate ${target ? "" : "opacity-65"}`}>{hint}</span>
      </span>
    </div>
  );
}
