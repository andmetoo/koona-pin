import { KeyboardEvent, PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpToLine, ChevronRight, CornerDownRight, FolderPlus, MoreHorizontal, Palette, Pencil, Trash2 } from "lucide-react";
import type { TFunction } from "i18next";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Collection } from "../../types";
import {
  ancestors,
  applyMove,
  buildTree,
  canCreateInside,
  canMoveInto,
  CollectionMove,
  findNode,
  flatten,
  keyboardMove,
  landsAfter,
  MAX_DEPTH,
  placeOf,
  subtreeIds,
  TreeDrop,
  treeDrop,
  TreeNode,
} from "../../services/collectionTree";
import { DropTarget, RowDragItem } from "../../services/drag";
import { savePreference, storedValue } from "../../services/preferences";
import { rowAt, useCollectionReorder } from "../../hooks/useCollectionReorder";
import { RowStack } from "../library/DragStack";
import { CollectionIcon } from "../ui/CollectionIcon";
import { Menu, MenuEntry } from "../ui/Menu";
import { Icon } from "../icons";
import { Drop, dropLook, FadeLabel, LandingLine } from "./sidebarParts";

/** Hovering a folded parent this long while dragging opens it (2.19.0, as the folded sections do). */
const OPEN_MS = 600;
/** Each level of the tree steps in this far (frame N1). */
const INDENT = 16;
/**
 * The chevron's own slot before the icon, the icon centred between it and the name (7 px each
 * side): an icon like `code`'s brackets read as one glyph with the chevron at N1's 13 px
 * (owner's review, 2.19.0).
 */
const CHEVRON = 21;
const FOLDED_KEY = "sidebar.collections.folded";

function storedFolded(): Set<number> {
  try {
    const ids = JSON.parse(storedValue(FOLDED_KEY) ?? "[]");
    return new Set(Array.isArray(ids) ? ids.filter((id): id is number => typeof id === "number") : []);
  } catch {
    return new Set();
  }
}

/** Steps in, at most to the third level: a tree synced deeper still fits the sidebar. */
const indentOf = (depth: number) => INDENT * Math.min(depth, MAX_DEPTH - 1);

export interface CollectionTreeProps {
  collections: Collection[];
  /** The open collection, highlighted; none elsewhere. */
  current: number | null;
  onCollection: (id: number) => void;
  onMove: (move: CollectionMove) => Promise<void>;
  onRename: (id: number, name: string) => Promise<void>;
  /** «Icon and colour…»: the popover is the Sidebar's, over the row. */
  onStyle: (collection: Collection, anchor: DOMRect) => void;
  onNewInside: (parent: Collection) => void;
  onDelete: (collection: Collection) => void;
  /** While the selection is dragged: each row's target (NP-030). */
  drop?: (target: DropTarget) => Drop | undefined;
  dropping: boolean;
  onAddToBundle: (item: RowDragItem, at: { x: number; y: number }) => void;
  /** A move failed: the Sidebar's owner says why. */
  onFailed: (err: unknown) => void;
}

/**
 * The collections as a tree (2.19.0, frames N1–N4), on the WAI-ARIA tree
 * pattern: one row in the tab order, arrows move and fold, `Alt` + arrows
 * move the collection, `F2` renames it. A row dragged lands before or after
 * another (its top or bottom quarter) or inside it (its middle); out of the
 * sidebar it goes to the bundle. Bookmarks dragged onto a row still move there.
 */
export function CollectionTree(props: CollectionTreeProps) {
  const { t } = useTranslation();
  const { collections, current, dropping } = props;
  const roots = useMemo(() => buildTree(collections), [collections]);
  const [folded, setFolded] = useState(storedFolded);
  /** Parents a drag has opened, for that drag only. */
  const [opened, setOpened] = useState<Set<number>>(new Set());
  const shut = useMemo(() => new Set([...folded].filter((id) => !opened.has(id))), [folded, opened]);
  const shown = useMemo(() => flatten(roots, shut), [roots, shut]);
  const [focused, setFocused] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [menuAt, setMenuAt] = useState<{ collection: Collection; anchor: DOMRect; trigger: Element } | null>(null);
  const [moved, setMoved] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const byId = (id: number) => collections.find((c) => c.id === id);

  const fold = (id: number, value: boolean) =>
    setFolded((was) => {
      // Only collections still here: a deleted one's id leaves the preference.
      const next = new Set([...was].filter((x) => collections.some((c) => c.id === x)));
      if (value) next.add(id);
      else next.delete(id);
      savePreference(FOLDED_KEY, JSON.stringify([...next]));
      return next;
    });
  const rowOf = (id: number) => list.current?.querySelector<HTMLElement>(`[data-collection-row="${id}"] [data-collection]`);
  /** After a move or a rename the row is drawn anew: focused on the next frame. */
  const focusRow = (id: number) => requestAnimationFrame(() => rowOf(id)?.focus());

  /** A move from any way in: shown at once, the parent it went into opened, the place announced. */
  const move = (change: CollectionMove, keepFocus = false) => {
    if (change.parent !== null) fold(change.parent, false);
    const after = buildTree(applyMove(collections, change));
    const place = placeOf(after, change.id);
    const name = byId(change.id)?.name ?? "";
    setMoved(
      place.parent
        ? t("sidebar.movedInto", { name, parent: place.parent.name, position: place.position, count: place.count })
        : t("sidebar.movedTop", { name, position: place.position, count: place.count }),
    );
    props.onMove(change).catch(props.onFailed);
    if (keepFocus) focusRow(change.id);
  };

  const reorder = useCollectionReorder<TreeDrop>(
    (box, from, x, y) => {
      const hit = rowAt(box, x, y);
      if (!hit) return null;
      return treeDrop(roots, shown, from, hit.index, hit.at < 0.25 ? "top" : hit.at > 0.75 ? "bottom" : "middle");
    },
    (from, to) => move({ id: from, parent: to.parent, before: to.before }),
    {
      item: (from) => ({ kind: "collection", collection: byId(from)! }),
      onDrop: (from, at) => props.onAddToBundle({ kind: "collection", collection: byId(from)! }, at),
    },
  );
  const moving = reorder.move;
  const landing = moving?.over ?? null;
  const movedNode = moving ? findNode(roots, moving.from) : undefined;
  const faded = useMemo(() => new Set(movedNode ? subtreeIds(movedNode) : []), [movedNode]);

  // Hovering a folded parent while dragging opens it; the drag's end folds it back.
  const dragging = !!moving || dropping;
  useEffect(() => {
    if (!dragging) return setOpened(new Set());
    let over: number | null = null;
    let timer = 0;
    const pointer = (e: globalThis.PointerEvent) => {
      const row = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-collection-row]");
      const id = row && list.current?.contains(row) ? Number(row.dataset.collectionRow) : null;
      if (id === over) return;
      over = id;
      window.clearTimeout(timer);
      if (id !== null) timer = window.setTimeout(() => setOpened((was) => new Set(was).add(id)), OPEN_MS);
    };
    window.addEventListener("pointermove", pointer);
    return () => {
      window.removeEventListener("pointermove", pointer);
      window.clearTimeout(timer);
    };
  }, [dragging]);

  const press = (id: number) => (e: PointerEvent) => {
    if (e.button !== 0 || dropping || renaming !== null || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    reorder.start(e, id, list.current);
  };

  const keys = (node: TreeNode<Collection>, index: number) => (e: KeyboardEvent) => {
    const id = node.item.id;
    const open = node.children.length > 0 && !shut.has(id);
    if (e.altKey) {
      const way = { ArrowUp: "up", ArrowDown: "down", ArrowRight: "in", ArrowLeft: "out" } as const;
      const key = way[e.key as keyof typeof way];
      if (!key) return;
      e.preventDefault();
      const change = keyboardMove(roots, id, key);
      if (change) move(change, true);
      return;
    }
    if (e.ctrlKey || e.metaKey) return;
    const go = (to: number) => {
      const target = shown[Math.max(0, Math.min(shown.length - 1, to))];
      // At once: a second key pressed before the next frame goes on from here.
      if (target) rowOf(target.item.id)?.focus();
    };
    switch (e.key) {
      case "ArrowDown":
        go(index + 1);
        break;
      case "ArrowUp":
        go(index - 1);
        break;
      case "Home":
        go(0);
        break;
      case "End":
        go(shown.length - 1);
        break;
      case "ArrowRight":
        if (node.children.length && !open) fold(id, false);
        else if (open) go(index + 1);
        else return;
        break;
      case "ArrowLeft": {
        if (open) fold(id, true);
        else {
          const parent = ancestors(roots, id).at(-1);
          if (!parent) return;
          rowOf(parent.id)?.focus();
        }
        break;
      }
      case "Enter":
      case " ":
        props.onCollection(id);
        break;
      case "F2":
        setRenaming(id);
        break;
      // The «…» menu from the keyboard: the menu key or Shift F10.
      case "ContextMenu":
      case "F10":
        if (e.key === "F10" && !e.shiftKey) return;
        openMenu(node.item, e.currentTarget as HTMLElement);
        break;
      default:
        return;
    }
    e.preventDefault();
  };
  const openMenu = (collection: Collection, trigger: HTMLElement) => {
    const button = trigger.closest("[data-collection-row]")?.querySelector<HTMLElement>("[data-collection-menu]") ?? trigger;
    setMenuAt({ collection, anchor: button.getBoundingClientRect(), trigger: button });
  };

  // The row in the tab order: the one last focused, else the open collection, else the first.
  const tabbable = [focused, current, shown[0]?.item.id].find((id) => id !== null && id !== undefined && shown.some((n) => n.item.id === id));

  const hint = landing && dropHint(t, roots, landing);
  const ghost =
    movedNode &&
    (moving!.outside ? (
      <RowStack item={{ kind: "collection", collection: movedNode.item }} over={moving!.bundle} stack={reorder.ghost} place={reorder.place} />
    ) : (
      // Into the body: the sidebar's scrolling section would cut the hint at its edge.
      createPortal(
        <div
          ref={(element) => {
            reorder.ghost.current = element;
            reorder.place();
          }}
          aria-hidden
          className="pointer-events-none fixed top-0 left-0 z-50 flex flex-col items-start gap-1.5"
        >
          <span className="flex max-w-[200px] items-center gap-2 rounded-md bg-card px-2.5 py-1.5 text-sm text-ink shadow-menu">
            <CollectionIcon collection={movedNode.item} size={14} />
            <span className="truncate">{movedNode.item.name}</span>
          </span>
          {hint && (
            <span data-drop-hint className="max-w-[240px] truncate rounded-md bg-toast px-2 py-1 text-xs text-white">
              {hint}
            </span>
          )}
        </div>,
        document.body,
      )
    ));

  // Every row is counted in its own group: the posinset among its siblings. One lookup per
  // tree, not a walk up the ancestors per row (2.19.0).
  const groupOf = useMemo(() => {
    const groups = new Map<number, TreeNode<Collection>[]>();
    const walk = (level: TreeNode<Collection>[]) => {
      for (const n of level) {
        groups.set(n.item.id, level);
        walk(n.children);
      }
    };
    walk(roots);
    return groups;
  }, [roots]);
  const siblingsOf = (node: TreeNode<Collection>) => groupOf.get(node.item.id) ?? roots;

  return (
    <>
      <div ref={list} role="tree" aria-label={t("sidebar.collections")} className="flex flex-col gap-0.5">
        {shown.map((node, index) => {
          const c = node.item;
          const depth = Math.min(node.depth, MAX_DEPTH - 1);
          const parent = node.children.length > 0;
          const open = parent && !shut.has(c.id);
          const active = current === c.id;
          const target = props.drop?.({ kind: "collection", id: c.id });
          const into = landing?.edge === "into" && landing.row === c.id;
          const hot = target?.hot || into;
          const siblings = siblingsOf(node);
          const look = hot
            ? dropLook(target ?? { attr: "", hot: true })
            : `${active ? "bg-raised font-semibold shadow-raised" : "hover:bg-hover"} text-ink`;
          return (
            <div key={c.id} data-collection-row={c.id} className={`group relative ${faded.has(c.id) ? "opacity-45" : ""}`}>
              {landing && landing.row === c.id && landing.edge !== "into" && (
                <LandingLine at={landing.edge === "before" ? "top" : "bottom"} indent={indentOf(landing.depth)} />
              )}
              {renaming === c.id ? (
                <RenameField
                  collection={c}
                  depth={depth}
                  onDone={(name) => {
                    setRenaming(null);
                    focusRow(c.id);
                    if (name !== null && name.trim() && name.trim() !== c.name) props.onRename(c.id, name).catch(props.onFailed);
                  }}
                />
              ) : (
                <div
                  role="treeitem"
                  aria-level={node.depth + 1}
                  aria-expanded={parent ? open : undefined}
                  aria-setsize={siblings.length}
                  aria-posinset={siblings.findIndex((n) => n.item.id === c.id) + 1}
                  aria-selected={active}
                  aria-current={active ? "page" : undefined}
                  aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight F2"
                  tabIndex={tabbable === c.id ? 0 : -1}
                  data-collection
                  data-drop={target?.attr}
                  onFocus={() => setFocused(c.id)}
                  onClick={() => props.onCollection(c.id)}
                  onPointerDown={press(c.id)}
                  onKeyDown={keys(node, index)}
                  style={{ paddingLeft: CHEVRON + indentOf(depth) }}
                  className={`relative flex h-8 w-full shrink-0 cursor-default items-center gap-[7px] rounded-[9px] pr-2.5 text-left text-sm transition-[background-color,color,box-shadow] duration-150 ${look}`}
                >
                  {parent && (
                    <span
                      aria-hidden
                      data-fold
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        fold(c.id, open);
                      }}
                      style={{ left: indentOf(depth) + 2, width: 12 }}
                      className="absolute top-1/2 flex h-5 -translate-y-1/2 items-center justify-center rounded-xs text-subtle hover:text-ink"
                    >
                      <Icon icon={ChevronRight} size={12} className={`transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
                    </span>
                  )}
                  <span className="flex shrink-0">
                    <CollectionIcon collection={c} />
                  </span>
                  <FadeLabel text={c.name} />
                  <span className={`text-xs font-normal ${hot ? "text-accent-muted" : "text-subtle"}`}>{node.total}</span>
                </div>
              )}
              {into && (
                <span data-drop-into className="sr-only">
                  {hint}
                </span>
              )}
              {/* `Alt` + arrows on keyboard focus only: with the mouse the rows are dragged (sheet 41). */}
              {!dropping && !moving && renaming === null && collections.length > 1 && (
                <span
                  role="tooltip"
                  className="pointer-events-none absolute top-full left-1/2 z-50 mt-1.5 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-md bg-toast px-2 py-1 text-xs text-white opacity-0 transition-opacity duration-150 group-has-[[data-collection]:focus-visible]:opacity-100"
                >
                  {t("sidebar.moveCollection")}
                  <kbd className="rounded-xs bg-white/15 px-1.5 font-sans text-2xs">Alt ← → ↑ ↓</kbd>
                </span>
              )}
              {!dropping && !moving && renaming !== c.id && (
                <button
                  type="button"
                  data-collection-menu
                  aria-label={t("sidebar.collectionMenu", { name: c.name })}
                  aria-haspopup="menu"
                  tabIndex={-1}
                  onClick={(e) => setMenuAt({ collection: c, anchor: e.currentTarget.getBoundingClientRect(), trigger: e.currentTarget })}
                  className={`absolute top-1.5 right-9 flex size-5 items-center justify-center rounded-xs text-faint hover:bg-hover hover:text-ink focus-visible:opacity-100 ${menuAt?.collection.id === c.id ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                >
                  <Icon icon={MoreHorizontal} size={14} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {ghost}
      <span aria-live="polite" className="sr-only">
        {moved}
      </span>
      {menuAt && (
        <Menu
          entries={collectionMenu(menuAt.collection, roots, t, {
            rename: () => setRenaming(menuAt.collection.id),
            style: () => props.onStyle(menuAt.collection, (menuAt.trigger.closest("[data-collection-row]") ?? menuAt.trigger).getBoundingClientRect()),
            newInside: () => {
              fold(menuAt.collection.id, false);
              props.onNewInside(menuAt.collection);
            },
            move: (parent) => move({ id: menuAt.collection.id, parent, before: null }),
            remove: () => props.onDelete(menuAt.collection),
          })}
          anchor={menuAt.anchor}
          align="start"
          label={t("sidebar.collectionMenu", { name: menuAt.collection.name })}
          trigger={menuAt.trigger}
          width={232}
          onClose={() => setMenuAt(null)}
        />
      )}
    </>
  );
}

/** What the hint under the dragged row says (frames N2, N3): «Into Hardware», «Into Development, after Rust». */
function dropHint(t: TFunction, roots: TreeNode<Collection>[], drop: TreeDrop): string {
  const parent = drop.parent === null ? undefined : findNode(roots, drop.parent)?.item;
  if (drop.edge === "into") return t("sidebar.dropInto", { name: parent?.name ?? "" });
  const after = landsAfter(roots, drop);
  if (!parent) return after ? t("sidebar.dropTopAfter", { after: after.name }) : t("sidebar.dropTopFirst");
  return after ? t("sidebar.dropIntoAfter", { name: parent.name, after: after.name }) : t("sidebar.dropIntoFirst", { name: parent.name });
}

/**
 * A collection's «…» menu (2.19.0, frame N4): Rename, Icon and colour, New
 * collection inside, Move to ▸ (the tree without itself and its own, its
 * parent ticked), Delete.
 */
export function collectionMenu(
  collection: Collection,
  roots: TreeNode<Collection>[],
  t: TFunction,
  actions: { rename: () => void; style: () => void; newInside: () => void; move: (parent: number | null) => void; remove: () => void },
): MenuEntry[] {
  const own = new Set(subtreeIds(findNode(roots, collection.id) ?? { item: collection, depth: 0, children: [], total: 0 }));
  const parent = collection.parent_id;
  const places = flatten(roots).filter((n) => !own.has(n.item.id));
  return [
    { id: "rename", icon: Pencil, label: t("sidebar.rename"), keys: "F2", onSelect: actions.rename },
    { id: "style", icon: Palette, label: t("sidebar.style"), onSelect: actions.style },
    {
      id: "inside",
      icon: FolderPlus,
      label: t("sidebar.newInside"),
      disabled: !canCreateInside(roots, collection.id),
      disabledHint: t("sidebar.tooDeep"),
      onSelect: actions.newInside,
    },
    {
      id: "move",
      icon: CornerDownRight,
      label: t("sidebar.moveTo"),
      submenuWidth: 248,
      submenu: [
        {
          id: "top",
          icon: ArrowUpToLine,
          label: t("sidebar.topLevel"),
          checked: parent === null,
          disabled: parent === null || !canMoveInto(roots, collection.id, null),
          onSelect: () => actions.move(null),
        },
        ...places.map((n) => {
          const fits = canMoveInto(roots, collection.id, n.item.id);
          return {
            id: `c${n.item.id}`,
            label: n.item.name,
            leading: <CollectionIcon collection={n.item} />,
            indent: Math.min(n.depth, MAX_DEPTH - 1),
            checked: parent === n.item.id,
            disabled: !fits || parent === n.item.id,
            disabledHint: fits ? undefined : t("sidebar.tooDeep"),
            onSelect: () => actions.move(n.item.id),
          };
        }),
        "separator",
        { hint: t("sidebar.moveKeys") },
      ],
    },
    "separator",
    { id: "delete", icon: Trash2, label: t("sidebar.deleteMenu"), onSelect: actions.remove },
  ];
}

/** «Rename» in place (2.19.0): Enter or leaving the field keeps the name, Esc puts the old one back. */
function RenameField({ collection, depth, onDone }: { collection: Collection; depth: number; onDone: (name: string | null) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(collection.name);
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  return (
    <form
      style={{ paddingLeft: CHEVRON - 1.5 + indentOf(depth) }}
      className="flex h-8 items-center gap-[7px] rounded-[9px] border-[1.5px] border-accent bg-card pr-2.5 shadow-[0_0_0_3px_color-mix(in_srgb,var(--np-accent)_25%,transparent)]"
      onSubmit={(e) => {
        e.preventDefault();
        finish(name);
      }}
    >
      <CollectionIcon collection={collection} />
      <input
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        aria-label={t("sidebar.renameField", { name: collection.name })}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => finish(name)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          finish(null);
        }}
        className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none selection:bg-accent/20"
      />
    </form>
  );
}
