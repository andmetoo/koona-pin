import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BookmarkChange, Collection } from "../../types";
import { api } from "../../services/api";
import { bundle, BundleView, entryKey, itemCount, sectionKey, viewLabel } from "../../services/bundle";
import { addedText, addView, pruneBundle, useBundle } from "./actions";
import { rowDropLabel } from "../../services/drag";
import { useSidebarDrag } from "../../hooks/useRowDrag";
import { Capsule, Landing, landingMs, onLanding } from "./Capsule";
import { Panel } from "./Panel";

/** The capsule's height and its gap to the window's edges (K6b). */
const CAPSULE = 48;
const EDGE = 24;
/** While the bulk bar shows the capsule rises above it (S6): 24, the bar's 52 (SelectionBar), 12. */
const OVER_BAR = EDGE + 52 + 12;
/**
 * The panel's bottom is 12 px above the capsule's top, its top at least 12 px under the toolbar;
 * it is at most 600 px high (M2).
 */
const GAP = 12;
const PANEL_MAX = 600;

/** What had the focus before the panel opened from outside it: the capsule, or ⋯ in the toolbar. */
let opener: HTMLElement | null = null;

/** Opens the panel; Esc gives the focus back to `from` (⋯), else to the capsule. */
export function openBundle(from: HTMLElement | null = null) {
  opener = from;
  bundle.setOpen(true);
}

const focusable = "button:not([disabled]), [href], input, textarea, select, [tabindex]:not([tabindex='-1'])";

/**
 * The bundle in the main area (share-bundle.md, piece B): the capsule at rest bottom right and the
 * panel above it. Both go while a modal dialog, reading mode or triage is open (`blocked`); the
 * contents stay. F6 moves the focus between the main list and the open panel.
 */
export function Bundle({
  view,
  viewCount,
  barShown,
  headHeight,
  blocked,
  drag,
  collections,
  announce,
}: {
  /** The view on screen as «Add {view}» would add it; null where nothing can be added (Trash). */
  view: BundleView | null;
  /** How many items the view holds. */
  viewCount: number;
  /** The bulk bar shows: the capsule sits above it. */
  barShown: boolean;
  /** The toolbar over the main area: the panel keeps 12 px under it. */
  headHeight: number;
  blocked: boolean;
  /** The selection is dragged: its count, and whether it is over the bundle. */
  drag: { count: number; over: boolean } | null;
  collections: Collection[];
  /** The app's polite live region. */
  announce: (text: string) => void;
}) {
  const { t } = useTranslation();
  const state = useBundle();
  // A collection, a tag, a feed or All feeds dragged out of the sidebar (piece C).
  const sidebar = useSidebarDrag();
  // A drop that added something: the capsule plays it, and stays on screen until it has, even when
  // hidden by × or when the add came in after the drag had ended.
  const [lastLanding, setLastLanding] = useState<Landing | null>(null);
  const [landing, setLanding] = useState(false);
  useEffect(() => {
    let timer = 0;
    const stop = onLanding((next) => {
      setLastLanding(next);
      setLanding(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        setLanding(false);
        // Played: a capsule that comes back later does not play it again.
        setLastLanding(null);
      }, landingMs(next.added));
    });
    return () => {
      stop();
      window.clearTimeout(timer);
    };
  }, []);
  const panelId = useId();
  const capsule = useRef<HTMLButtonElement>(null);
  // The main area's height: the panel fits between its toolbar and the capsule.
  const probe = useRef<HTMLSpanElement>(null);
  const [mainHeight, setMainHeight] = useState(() => window.innerHeight);
  useEffect(() => {
    const main = probe.current?.closest("main");
    if (!main) return;
    const observer = new ResizeObserver(() => setMainHeight(main.clientHeight));
    observer.observe(main);
    setMainHeight(main.clientHeight);
    return () => observer.disconnect();
  }, []);
  // A collection's section follows its renames.
  useEffect(() => bundle.follow(collections), [collections]);
  // Items deleted or moved to Trash leave the bundle when the library changes under it, and on open.
  // A bookmark trashed while the panel is open leaves it at once, so Save never writes it.
  useEffect(() => {
    const prune = () => void pruneBundle();
    // Deleted (no bookmark) or moved to Trash; other edits leave the bundle as it is.
    const gone = (change: BookmarkChange) => !change.bookmark || !!change.bookmark.deleted_at;
    const stops = [
      api.onLibraryInvalidated(prune),
      api.onBookmarkChanged((change) => gone(change) && prune()),
      api.onBookmarksChanged((changes) => changes.some(gone) && prune()),
    ];
    return () => stops.forEach((stop) => stop());
  }, []);
  const open = state.open && !blocked;
  useEffect(() => {
    if (open) void pruneBundle();
  }, [open]);

  const count = itemCount(state);
  const capsuleBottom = barShown ? OVER_BAR : EDGE;
  const panelBottom = capsuleBottom + CAPSULE + GAP;
  const panelHeight = Math.max(0, Math.min(PANEL_MAX, mainHeight - (headHeight + GAP) - (capsuleBottom + CAPSULE) - GAP));

  // «Add {view} · N» shows while the view is not in the bundle yet and holds something.
  const [covered, setCovered] = useState(false);
  const viewKey = view && (view.kind === "links" ? JSON.stringify(view.filters) : view.kind);
  useEffect(() => {
    if (!open || view?.kind !== "links") return setCovered(false);
    let live = true;
    const inBundle = new Set(state.sections.flatMap((s) => s.entries.map(entryKey)));
    void api.getBookmarkIds(view.filters).then((ids) => live && setCovered(ids.length > 0 && ids.every((id) => inBundle.has(`b:${id}`))), () => {});
    return () => {
      live = false;
    };
    // The view's filters by their key: a new object for the same view checks nothing new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, viewKey, state.sections]);
  const inBundle = (key: string) => state.sections.some((s) => s.entries.some((e) => entryKey(e) === key));
  const offered =
    !!view &&
    viewCount > 0 &&
    (view.kind === "collection"
      ? !state.sections.some((s) => s.key === sectionKey({ kind: "collection", id: view.collection.id }))
      : view.kind === "tag"
        ? !state.sections.some((s) => s.key === sectionKey({ kind: "tag", name: view.name }))
        : view.kind === "feeds"
          ? !view.feeds.every((f) => inBundle(`f:${f.uid}`))
          : !covered);
  const add =
    offered && view
      ? {
          label: t("bundle.addView", { name: viewLabel(view), count: viewCount }),
          onAdd: () =>
            void addView(view).then(
              (added) => announce(addedText(t, added)),
              (err) => announce(String(err)),
            ),
        }
      : null;

  const close = () => {
    bundle.setOpen(false);
    const back = opener?.isConnected ? opener : capsule.current;
    opener = null;
    back?.focus();
  };
  // F6: between the main list and the open panel, both ways.
  const lastInMain = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const panel = () => document.getElementById(panelId);
    const focusin = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      if (!panel()?.contains(target) && target.closest("main")) lastInMain.current = target;
    };
    const keydown = (e: KeyboardEvent) => {
      if (e.key !== "F6" || e.ctrlKey || e.metaKey || e.altKey) return;
      const element = panel();
      if (!element) return;
      e.preventDefault();
      if (element.contains(document.activeElement)) {
        const main = element.closest("main");
        const remembered = lastInMain.current?.isConnected ? lastInMain.current : null;
        const card = main?.querySelector<HTMLElement>("[data-view] [data-bookmark-id]");
        const any = [...(main?.querySelectorAll<HTMLElement>(focusable) ?? [])].find((el) => !element.contains(el) && !el.closest("[data-bundle-capsule]"));
        (remembered ?? card ?? any)?.focus();
      } else {
        (element.querySelector<HTMLElement>("[data-bundle-row] button") ?? element.querySelector<HTMLElement>(focusable))?.focus();
      }
    };
    document.addEventListener("focusin", focusin);
    window.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("focusin", focusin);
      window.removeEventListener("keydown", keydown);
    };
  }, [open, panelId]);

  const probeElement = <span ref={probe} hidden />;
  if (blocked) return probeElement;
  // At rest it shows while it holds something and was not hidden; any drag brings it, a drag from the
  // sidebar once the pointer has left the sidebar (S13). A landing keeps it until it has played.
  const dragging = !!drag || !!sidebar?.shown;
  const shown = (count > 0 && !state.hidden) || dragging || landing;
  const overLabel = drag?.over ? t("drag.bundle", { count: drag.count }) : sidebar?.shown && sidebar.over ? rowDropLabel(t, sidebar.item) : null;
  const over = !!overLabel;
  return (
    <>
      {probeElement}
      {shown && (
        <Capsule
          ref={capsule}
          count={count}
          entries={state.sections.flatMap((s) => s.entries).slice(0, 3)}
          bottom={capsuleBottom}
          dragging={dragging}
          over={overLabel}
          expanded={open}
          panelId={panelId}
          landing={lastLanding}
          onClick={() => (open ? close() : openBundle(null))}
          onHide={() => {
            bundle.setHidden(true);
            if (open) bundle.setOpen(false);
          }}
        />
      )}
      {open && (
        <Panel
          id={panelId}
          state={state}
          bottom={panelBottom}
          height={panelHeight}
          dragging={dragging}
          over={over}
          add={add}
          onClose={close}
        />
      )}
    </>
  );
}
