import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Plus, Settings } from "lucide-react";
import { selection } from "../../platform/haptics";
import { useBack } from "../../platform/useBack";
import { TABS } from "./navigation/stack";
import { usePhone } from "./PhoneContext";
import { CircleButton } from "./ui/buttons";
import { glass } from "./ui/Glass";
import { TAB_ICONS } from "./ui/NavPill";
import { PhIcon } from "./ui/icons";
import { useLongPress } from "./ui/useLongPress";
import { openSettings } from "./you/settingsRoute";

/**
 * The Fold's vertical rail (doc/mobile-design.md, "Foldables"; FL1R/FL2R, mirrored in FL1/FL2): a
 * floating chrome-glass pill 72 wide, clear of the edge's back-gesture strip and anchored low above
 * the gesture inset, on the side the person holds (`data-hand` on the shell's root). On top the
 * four places (Inbox with its count; the open one on an accent-soft pill), a hairline, then the
 * thumb part: the screen's primary action as a flat accent circle (Read on a bookmark, Save on a
 * post; none when the screen offers none) and the ink "+" at the very bottom. No labels; a long
 * press anywhere on it opens a small popover to move the controls to the other side (FL3).
 */
export function Rail() {
  const { app, stack, sheets, primary, keyboardUp } = usePhone();
  const { t } = app;
  const [menu, setMenu] = useState(false);
  const press = useLongPress(() => {
    void selection();
    setMenu(true);
  });
  const inbox = app.counts.inbox;
  const then = (run: () => void) => () => {
    setMenu(false);
    run();
  };
  return (
    <>
      <nav
        aria-label={t("phone.rail.label")}
        data-rail
        data-open={menu || undefined}
        data-hidden={keyboardUp || undefined}
        inert={keyboardUp || undefined}
        className={`ph-rail ${glass()}`}
        {...press}
      >
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            aria-label={t(`phone.nav.${tab}`)}
            aria-current={tab === stack.tab ? "page" : undefined}
            className="ph-rail-slot"
            onClick={then(() => stack.selectTab(tab))}
          >
            <PhIcon icon={TAB_ICONS[tab]} at="nav" />
            {tab === "inbox" && inbox > 0 && (
              <span className="ph-rail-badge" aria-hidden="true">
                {inbox > 99 ? "99+" : inbox}
              </span>
            )}
          </button>
        ))}
        <span className="ph-rail-rule" aria-hidden="true" />
        {primary && (
          <CircleButton
            icon={primary.icon}
            kind="accent"
            size={56}
            label={primary.label}
            aria-pressed={primary.pressed}
            className="ph-rail-primary"
            data-rail-primary
            onClick={then(primary.run)}
          >
            <PhIcon icon={primary.icon} at="nav" />
          </CircleButton>
        )}
        <CircleButton kind="ink" size={56} label={t("phone.nav.new")} className="ph-rail-new" onClick={then(() => sheets.open({ kind: "newLink", props: {} }))}>
          <PhIcon icon={Plus} at="nav" />
        </CircleButton>
      </nav>
      {menu && <RailMenu onClose={() => setMenu(false)} />}
    </>
  );
}

/**
 * FL3's popover beside the rail: "Navigation rail", move the controls to the other side, or the
 * Layout page of Settings. A tap outside, Escape or Back closes it.
 */
function RailMenu({ onClose }: { onClose: () => void }) {
  const { app, stack, hand, setHand } = usePhone();
  const { t } = app;
  const first = useRef<HTMLButtonElement>(null);
  useBack(onClose);
  useEffect(() => {
    first.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const other = hand === "right" ? "left" : "right";
  return (
    <>
      <div className="ph-rail-scrim" aria-hidden="true" onClick={onClose} />
      <div role="menu" aria-label={t("phone.rail.menu")} className={`ph-rail-menu ${glass()}`} data-rail-menu>
        <p className="ph-rail-menu-title" aria-hidden="true">
          {t("phone.rail.menu")}
        </p>
        <button
          ref={first}
          type="button"
          role="menuitem"
          className="ph-rail-menu-item"
          data-main
          onClick={() => {
            onClose();
            setHand(other);
          }}
        >
          <PhIcon icon={other === "left" ? ArrowLeft : ArrowRight} />
          {t(other === "left" ? "phone.rail.moveLeft" : "phone.rail.moveRight")}
        </button>
        <button
          type="button"
          role="menuitem"
          className="ph-rail-menu-item"
          onClick={() => {
            onClose();
            openSettings(stack, "layout");
          }}
        >
          <PhIcon icon={Settings} />
          {t("phone.rail.layout")}
        </button>
      </div>
    </>
  );
}
