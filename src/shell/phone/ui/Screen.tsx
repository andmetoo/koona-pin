import { createContext, type ReactNode, type Ref, useContext, useEffect, useRef } from "react";

/**
 * The account cluster the shell puts in every header unless a screen says otherwise: the shell
 * provides it wired to the app (Supporter, sync, the "You & sync" sheet); the kit gallery has none.
 */
export const AccountSlot = createContext<ReactNode>(null);

/**
 * A large-title header (doc/mobile-design.md, Headers): the title (display) with an optional meta
 * line or a `beside` (triage's "5 of 12") on the left, circle buttons and the account cluster on
 * the right. The title scrolls with the content; the buttons stay, over the top edge's fade.
 * Put it first in a {@link Screen}. `account={false}` leaves the cluster out (triage, Search).
 */
export function Header({
  title,
  meta,
  beside,
  actions,
  account,
  children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  /** Next to the title on its line. */
  beside?: ReactNode;
  /** Circle buttons, left of the account cluster. */
  actions?: ReactNode;
  /** The cluster, or false for none; by default the shell's. */
  account?: ReactNode | false;
  /** Under the title: a progress bar, the search field. */
  children?: ReactNode;
}) {
  const shellAccount = useContext(AccountSlot);
  const cluster = account === false ? null : (account ?? shellAccount);
  return (
    <>
      {(actions || cluster) && (
        <div className="ph-header-bar">
          <div className="ph-header-actions">
            {actions}
            {cluster}
          </div>
        </div>
      )}
      <header className="ph-header">
        <div className="ph-header-title">
          <h1 className="ph-display">{title}</h1>
          {beside}
        </div>
        {meta && <p className="ph-meta">{meta}</p>}
        {children}
      </header>
    </>
  );
}

/**
 * One screen (doc/mobile-design.md, Screens): it scrolls by itself under the safe area, keeps its
 * last rows clear of the nav pill while the pill shows, and fades its top edge once scrolled.
 * `hidden`: a pushed route covers it; it stays mounted and keeps its scroll.
 */
export function Screen({
  label,
  hidden = false,
  route,
  children,
  className = "",
  scrollRef,
}: {
  /** The screen's name for screen readers (its title). */
  label: string;
  hidden?: boolean;
  /** A pushed screen: it slides in over its tab. */
  route?: boolean;
  children: ReactNode;
  className?: string;
  scrollRef?: Ref<HTMLElement>;
}) {
  const own = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = own.current;
    if (!el) return;
    const onScroll = () => {
      const scrolled = el.scrollTop > 4;
      if (scrolled !== el.hasAttribute("data-scrolled")) el.toggleAttribute("data-scrolled", scrolled);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <main
      ref={(el) => {
        own.current = el;
        if (typeof scrollRef === "function") scrollRef(el);
        else if (scrollRef) scrollRef.current = el;
      }}
      aria-label={label}
      hidden={hidden}
      inert={hidden || undefined}
      data-screen
      data-route={route || undefined}
      className={`ph-screen ${className}`}
    >
      <div className="ph-fade-top" aria-hidden="true" />
      {children}
    </main>
  );
}
