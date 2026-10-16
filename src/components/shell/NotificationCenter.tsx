import { KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bell, X, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Bookmark } from "../../types";
import { savePreference, storedValue } from "../../services/preferences";
import { Icon } from "../icons";
import { Preview } from "../library/Bookmarks";
import { recentTime } from "../../services/relativeTime";

/**
 * One thing the app wants to tell (2026-10-16, banner variant D): the inbox waiting, the
 * import offer of a new library, the browser that can't send bookmarks. They used to be
 * banners over the library; now they wait behind the bell in the sidebar.
 */
export interface AppNotification {
  /** Read state is kept by this key: a new key is a new, unread notification. */
  key: string;
  /** `problem` draws the icon and the bell's badge in amber; `task` is work the app does in the background. */
  kind: "inbox" | "offer" | "problem" | "task";
  icon: LucideIcon;
  title: string;
  text: string;
  /** When it happened, if the app knows: «now», «5 min ago». */
  at?: string | null;
  /** The newest bookmarks it is about, a fan of up to three. */
  thumbs?: Bookmark[];
  /** `stay`: the centre stays open, as for «Stop» of a task under way. */
  action?: { label: string; run: () => void; stay?: boolean };
  /** The ×; none for what can't be dismissed, such as a problem. */
  dismiss?: { label: string; run: () => void };
  /** A task under way: its share done, 0 to 1, as a thin bar. */
  progress?: number;
  /** Never unread: a task under way is news only once it ends, under a new key. */
  quiet?: boolean;
}

const SEEN = "notifications.seen";
const WIDTH = 368;
const EDGE = 8;

function storedSeen(): Set<string> {
  try {
    const list: unknown = JSON.parse(storedValue(SEEN) ?? "[]");
    return new Set(Array.isArray(list) ? list.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * The bell and its glass popover. `below` in the sidebar's header, `right` of the narrow
 * strip. A notification is unread until the centre has been opened while it was there; the
 * badge counts the unread ones, in amber while a problem is among them.
 */
export function NotificationCenter({
  items,
  place,
  onClearAll,
}: {
  items: AppNotification[];
  place: "below" | "right";
  onClearAll: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(storedSeen);
  /** Unread when this opening began: their dots stay while it is open. */
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const bell = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight: number; origin: string } | null>(null);
  const id = useId();
  const heading = `${id}-title`;

  const unread = items.filter((n) => !n.quiet && !seen.has(n.key));
  const problem = items.some((n) => n.kind === "problem");
  const keys = items.map((n) => n.key).join("\n");

  // Open, everything shown is read; what arrives while it is open is read too.
  useEffect(() => {
    if (!open) return;
    const now = items.map((n) => n.key);
    const loud = items.filter((n) => !n.quiet).map((n) => n.key);
    setFresh((before) => new Set([...before, ...loud.filter((k) => !seen.has(k))]));
    if (now.every((k) => seen.has(k))) return;
    const next = new Set([...seen, ...now]);
    setSeen(next);
    // Only the keys of what is there: a dismissed or gone one needs no memory.
    savePreference(SEEN, JSON.stringify(now));
  }, [open, keys]);

  // The panel goes to the top layer, above everything the page paints: in a narrow window it
  // lies over the library, and WKWebView on macOS drew a scroll container's scrollbar across a
  // panel that was only `position: fixed` with a z-index. Without the Popover API it stays that.
  useLayoutEffect(() => {
    const element = panel.current;
    if (!open || !element || typeof element.showPopover !== "function") return;
    if (!element.matches(":popover-open")) element.showPopover();
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const place_ = () => {
      const rect = bell.current!.getBoundingClientRect();
      const width = Math.min(WIDTH, innerWidth - 2 * EDGE);
      const left =
        place === "right"
          ? Math.min(rect.right + 12, innerWidth - width - EDGE)
          : Math.max(EDGE, Math.min(rect.left - 12, innerWidth - width - EDGE));
      const top = place === "right" ? Math.max(EDGE, rect.top - 6) : rect.bottom + 8;
      const origin = place === "right" ? `0 ${rect.top + rect.height / 2 - top}px` : `${rect.left + rect.width / 2 - left}px 0`;
      setPosition({ left, top, maxHeight: innerHeight - top - 12, origin });
    };
    place_();
    window.addEventListener("resize", place_);
    return () => window.removeEventListener("resize", place_);
  }, [open, place]);

  // Focus goes in once it is placed: the first notification's action, or the panel itself.
  const focused = useRef(false);
  useEffect(() => {
    if (!open || !position || focused.current) return;
    focused.current = true;
    const first = panel.current?.querySelector<HTMLElement>("[data-notification-action]");
    (first ?? panel.current)?.focus();
  }, [open, position]);

  // A notification that went (×, Clear all) took the focus with it: it comes back into the panel.
  useEffect(() => {
    if (!open || !focused.current || !panel.current) return;
    if (panel.current.contains(document.activeElement)) return;
    const first = panel.current.querySelector<HTMLElement>("[data-notification-action]");
    (first ?? panel.current).focus();
  }, [keys]);

  // Esc closes the centre wherever the focus is while it is open, and only the centre.
  useEffect(() => {
    if (!open) return;
    const escape = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    };
    window.addEventListener("keydown", escape, { capture: true });
    return () => window.removeEventListener("keydown", escape, { capture: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (bell.current?.contains(target) || panel.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  function close(returnFocus: boolean) {
    setOpen(false);
    setFresh(new Set());
    setPosition(null);
    focused.current = false;
    if (returnFocus) bell.current?.focus();
  }

  const buttons = () => Array.from(panel.current?.querySelectorAll<HTMLElement>("button") ?? []);
  const keyDown = (e: KeyboardEvent) => {
    const all = buttons();
    if (!all.length) return;
    const at = all.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      e.preventDefault();
      e.stopPropagation();
      all[(to + all.length) % all.length].focus();
    };
    if (e.key === "ArrowDown") move(at + 1);
    else if (e.key === "ArrowUp") move(at < 0 ? all.length - 1 : at - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(all.length - 1);
    // Tab keeps to the panel, as in a dialog; Esc or a click outside leaves it.
    else if (e.key === "Tab") move(e.shiftKey ? (at < 0 ? all.length - 1 : at - 1) : at + 1);
  };

  /** After a ×, the focus stays at the same place in what is left. */
  const dismiss = (n: AppNotification, index: number) => {
    n.dismiss!.run();
    requestAnimationFrame(() => {
      const actions = Array.from(panel.current?.querySelectorAll<HTMLElement>("[data-notification-action]") ?? []);
      (actions[Math.min(index, actions.length - 1)] ?? panel.current)?.focus();
    });
  };

  const label = unread.length
    ? t("notifications.bellUnread", { count: unread.length })
    : problem
      ? t("notifications.bellProblem")
      : t("notifications.title");

  return (
    <>
      <button
        ref={bell}
        type="button"
        aria-label={label}
        title={t("notifications.title")}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        data-notification-bell
        onClick={() => (open ? close(false) : setOpen(true))}
        className={`notify-bell ${place === "right" ? "notify-bell-strip" : ""}`}
      >
        <Icon icon={Bell} size={16} />
        {unread.length > 0 ? (
          <span aria-hidden className={`notify-badge ${problem ? "notify-badge-problem" : ""}`}>
            {unread.length}
          </span>
        ) : (
          problem && <span aria-hidden className="notify-dot" />
        )}
      </button>
      {open &&
        createPortal(
          <section
            ref={panel}
            id={id}
            role="dialog"
            aria-labelledby={heading}
            tabIndex={-1}
            popover="manual"
            data-menu
            data-notification-center
            onKeyDown={keyDown}
            className="notify-center"
            style={
              position
                ? { left: position.left, top: position.top, maxHeight: position.maxHeight, transformOrigin: position.origin }
                : { left: -9999, top: -9999 }
            }
          >
            <header className="notify-head">
              <h2 id={heading}>{t("notifications.title")}</h2>
              {items.some((n) => n.dismiss) && (
                <button
                  type="button"
                  onClick={() => {
                    onClearAll();
                    requestAnimationFrame(() => {
                      const first = panel.current?.querySelector<HTMLElement>("[data-notification-action]");
                      (first ?? panel.current)?.focus();
                    });
                  }}
                >
                  {t("notifications.clearAll")}
                </button>
              )}
            </header>
            {items.length ? (
              <ul className="notify-list">
                {items.map((n, index) => {
                  const time = n.at ? recentTime(n.at, i18n.language) : null;
                  const title = `${id}-${n.key}`;
                  return (
                    <li key={n.key} className={`nt nt-${n.kind}`} aria-labelledby={title} data-notification={n.kind}>
                      {fresh.has(n.key) && (
                        <span className="nt-unread">
                          <span className="sr-only">{t("notifications.unread")}</span>
                        </span>
                      )}
                      <span className="nt-icon">
                        <Icon icon={n.icon} size={17} />
                      </span>
                      <p className="nt-title">
                        <span id={title}>{n.title}</span>
                        {time && <time dateTime={n.at!}>{time}</time>}
                      </p>
                      {n.text && <p className="nt-text">{n.text}</p>}
                      {n.progress !== undefined && (
                        <span
                          className="nt-progress"
                          role="progressbar"
                          aria-labelledby={title}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.round(n.progress * 100)}
                        >
                          <span style={{ width: `${Math.min(100, Math.max(0, n.progress * 100))}%` }} />
                        </span>
                      )}
                      {(n.action || !!n.thumbs?.length) && (
                      <div className="nt-actions">
                        {!!n.thumbs?.length && (
                          <span className="nt-thumbs" aria-hidden>
                            {n.thumbs.slice(0, 3).map((b) => (
                              <span key={b.id} className="nt-thumb">
                                <Preview b={b} small />
                              </span>
                            ))}
                          </span>
                        )}
                        {n.action && (
                          <button
                            type="button"
                            data-notification-action
                            className={`nt-button ${n.kind === "inbox" ? "nt-button-primary" : ""}`}
                            onClick={() => {
                              if (!n.action!.stay) close(false);
                              n.action!.run();
                            }}
                          >
                            {n.action.label}
                          </button>
                        )}
                      </div>
                      )}
                      {n.dismiss && (
                        <button type="button" className="nt-x" aria-label={n.dismiss.label} title={n.dismiss.label} onClick={() => dismiss(n, index)}>
                          <Icon icon={X} size={13} />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="notify-empty">
                <span className="notify-empty-icon">
                  <Icon icon={Bell} size={18} />
                </span>
                <p className="notify-empty-title">{t("notifications.empty")}</p>
                <p className="notify-empty-text">{t("notifications.emptyHint")}</p>
              </div>
            )}
          </section>,
          document.body,
        )}
    </>
  );
}
