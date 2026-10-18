import { Plus } from "lucide-react";
import { TABS } from "./navigation/stack";
import { usePhone } from "./PhoneContext";
import { CircleButton } from "./ui/buttons";
import { glass } from "./ui/Glass";
import { TAB_ICONS } from "./ui/NavPill";
import { PhIcon } from "./ui/icons";

/**
 * The Fold's vertical rail (placeholder, NP-072b wave 0; wave 2 builds it): above 840 dp it takes
 * the nav pill's place on the right edge (`data-hand="left"` on the shell root mirrors it), the
 * four places on top and "+" at the bottom, so navigation works on the inner screen meanwhile.
 */
export function Rail() {
  const { app, stack, sheets, hand } = usePhone();
  const { t } = app;
  return (
    <nav aria-label={t("phone.rail.label")} data-rail className={glass()} style={{ ...railStyle, ...(hand === "left" ? { right: "auto", left: "calc(24px + var(--safe-left))" } : {}) }}>
      {TABS.map((tab) => (
        <button
          key={tab}
          type="button"
          aria-label={t(`phone.nav.${tab}`)}
          aria-current={tab === stack.tab ? "page" : undefined}
          className="ph-navpill-slot"
          style={{ width: 56, height: 56, background: tab === stack.tab ? "var(--ph-accent-soft)" : undefined, color: tab === stack.tab ? "var(--ph-accent)" : undefined }}
          onClick={() => stack.selectTab(tab)}
        >
          <PhIcon icon={TAB_ICONS[tab]} at="nav" />
        </button>
      ))}
      <span style={{ flex: 1 }} />
      <CircleButton icon={Plus} kind="ink" size={52} label={t("phone.nav.new")} onClick={() => sheets.open({ kind: "newLink", props: {} })} />
    </nav>
  );
}

const railStyle = {
  position: "absolute",
  zIndex: 20,
  right: "calc(24px + var(--safe-right))",
  top: "calc(var(--safe-top) + 96px)",
  bottom: "max(24px, var(--safe-bottom))",
  width: 72,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 8,
  padding: "8px 0",
  borderRadius: 999,
} as const;
