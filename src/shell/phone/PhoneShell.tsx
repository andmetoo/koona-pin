import "../../styles/phone.css";
import { type CSSProperties, useCallback, useMemo, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { useAppState } from "../../app/appState";
import { useMedia } from "../../app/layout";
import { useKeyboardUp } from "../../platform/keyboard";
import { preference, savePreference } from "../../services/preferences";
import { usePhoneStack } from "./navigation/usePhoneStack";
import { type Phone, PhoneContext, type PrimaryAction, usePhone } from "./PhoneContext";
import { PhoneDialogs } from "./PhoneDialogs";
import { Rail } from "./Rail";
import { ScreenStack } from "./ScreenStack";
import { SheetLayer } from "./sheets/SheetLayer";
import { useAppSheets } from "./sheets/useAppSheets";
import { SheetsContext, useSheetState } from "./sheets/useSheets";
import { isSupporter, syncState } from "./ui/accountState";
import { AccountCluster } from "./ui/AccountCluster";
import { NavPill } from "./ui/NavPill";
import { AccountSlot } from "./ui/Screen";
import { Snackbar } from "./ui/Snackbar";

/** From this width the window is "expanded" (Material): the unfolded Fold gets the rail. */
const FOLD = "(min-width: 840px)";

/**
 * A phone's app (NP-072b, "Paper & Glass", doc/mobile-design.md): the static mesh background, the
 * tab's screen or the route pushed over it, the nav pill (the rail on an unfolded Fold), the
 * snackbar for the app's notices and Undo, one layer of sheets, and the shared dialogs a phone
 * still shows. Screens and sheets reach all of it through `usePhone()` (src/shell/phone/README.md).
 */
export function PhoneShell() {
  // The snackbar keeps its own time (5 s, paused while touched): the app's notices wait for it.
  const app = useAppState(null, { noticeTiming: () => null });
  const fold = useMedia(FOLD);
  const stack = usePhoneStack(app, fold);
  const { entries, sheets, exited } = useSheetState();
  useAppSheets(app, sheets, entries);
  const keyboardUp = useKeyboardUp();
  const [bottomLift, setBottomLift] = useState(0);
  // The Fold's controls on the right by default; per device, not synced (doc/mobile-design.md).
  const [hand, setHandState] = useState(() => preference<"right" | "left">("foldHand", ["right", "left"], "right"));
  const setHand = useCallback((side: "right" | "left") => {
    setHandState(side);
    savePreference("foldHand", side);
  }, []);
  const pillShown = !fold && stack.atRoot && !keyboardUp;
  const [primary, setPrimary] = useState<PrimaryAction | null>(null);
  // The row of what the Fold's detail pane shows is marked; a phone marks none.
  const { detail } = stack;
  const bookmarkId = fold && (detail?.name === "bookmark" || detail?.name === "reader") ? detail.bookmarkId : null;
  const postId = fold && detail?.name === "post" ? detail.itemId : null;
  const selected = useMemo(() => ({ bookmarkId, postId }), [bookmarkId, postId]);

  const phone = useMemo<Phone>(
    () => ({ app, stack, sheets, fold, hand, setHand, keyboardUp, pillShown, setBottomLift, selected, primary, setPrimary }),
    [app, stack, sheets, fold, hand, setHand, keyboardUp, pillShown, selected, primary],
  );
  const account = useMemo(
    () => (
      <AccountCluster
        supporter={isSupporter(app.supporter)}
        sync={syncState(app.sync)}
        badge={app.badge}
        onOpen={() => sheets.open({ kind: "you", props: {} })}
      />
    ),
    [app.supporter, app.sync, app.badge, sheets],
  );

  return (
    <PhoneContext.Provider value={phone}>
      <SheetsContext.Provider value={sheets}>
        <AccountSlot.Provider value={account}>
          {/* TODO(NP-072b): `data-glass="flat"` for Android's battery saver and slow devices, once the
              bridge reports them (README.md). */}
          <div
            className="phone"
            data-phone
            data-fold={fold || undefined}
            data-hand={hand}
            data-pill={pillShown || undefined}
            data-keyboard={keyboardUp || undefined}
            style={{ "--ph-lift": `${bottomLift}px` } as CSSProperties}
          >
            <div className="ph-main">
              <ScreenStack />
              {pillShown && <div className="ph-fade-bottom" aria-hidden="true" />}
            </div>
            {fold ? (
              <Rail />
            ) : (
              <NavPill
                tab={stack.tab}
                inbox={app.counts.inbox}
                hidden={!pillShown}
                onTab={stack.selectTab}
                onNew={() => sheets.open({ kind: "newLink", props: {} })}
              />
            )}
            <PhoneSnackbar />
            <SheetLayer entries={entries} close={sheets.close} exited={exited} />
            {/* What a screen reader hears of the selection and the bundle (app/notices.ts). */}
            <p aria-live="polite" className="sr-only">
              {app.announcement}
            </p>
          </div>
          {/* Outside the phone's root: the shared dialogs keep the desktop's type and colours. */}
          <PhoneDialogs />
        </AccountSlot.Provider>
      </SheetsContext.Provider>
    </PhoneContext.Provider>
  );
}

/**
 * The app's notice as the snackbar: Undo, Show or Try again as its action; an alert stays until
 * closed. A new notice is a new snackbar with its own 5 s.
 */
function PhoneSnackbar() {
  const { app } = usePhone();
  const { notice, setNotice, t } = app;
  const keys = useRef(new WeakMap<object, number>());
  const next = useRef(1);
  if (!notice) return null;
  if (!keys.current.has(notice)) keys.current.set(notice, next.current++);
  const close = () => setNotice((now) => (now === notice ? null : now));
  const action = notice.undo
    ? { label: t("notice.undo"), run: notice.undo }
    : notice.show
      ? { label: t("export.show"), run: notice.show }
      : notice.retry
        ? {
            label: t("common.retry"),
            run: () => {
              setNotice(null);
              notice.retry?.();
            },
          }
        : notice.alert
          ? { label: t("common.close"), run: () => setNotice(null) }
          : undefined;
  return (
    <div className="ph-snackbar-slot">
      <Snackbar
        key={keys.current.get(notice)}
        text={notice.text}
        alert={notice.alert}
        icon={notice.icon === "trash" ? Trash2 : undefined}
        action={action}
        onTimeout={close}
      />
    </div>
  );
}
