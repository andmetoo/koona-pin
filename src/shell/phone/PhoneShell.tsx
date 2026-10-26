import "../../styles/phone.css";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { useAppState } from "../../app/appState";
import { useMedia } from "../../app/layout";
import { capabilities } from "../../platform/capabilities";
import { useKeyboardUp } from "../../platform/keyboard";
import { flatGlass, largeText, useSystemSignals } from "../../platform/system";
import { useVerticalBar, type VerticalBar } from "../../platform/verticalBar";
import { api } from "../../services/api";
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
import { useOverDialogs } from "../../components/ui/overDialogs";

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
  // Battery saver or a low-RAM device: the glass as opaque paper (phone.css, the fallback). The
  // system's font size scales the text already (the WebView's text zoom); the root names it for
  // what keeps its size and for the accessibility sizes' layout.
  const system = useSystemSignals();
  const [bottomLift, setBottomLift] = useState(0);
  // The Fold's controls on the right by default; per device, not synced (doc/mobile-design.md).
  const [chosenHand, setHandState] = useState(() => preference<"right" | "left">("foldHand", ["right", "left"], "right"));
  const setHand = useCallback((side: "right" | "left") => {
    setHandState(side);
    savePreference("foldHand", side);
  }, []);
  // iPhone Duo (iOS 27.1): the rail lives in the system's vertical bar, on the side the system
  // puts it; the controls do not change sides there (Apple: the bar stays on the device's side).
  const bar = useVerticalBar();
  const hand = bar ? bar.edge : chosenHand;
  const [column, setColumn] = useState<HTMLElement | null>(null);
  // The status block's end on each display (the inner one has the fold), kept while a fold or a
  // rotation reports none for a moment; until one is known, what the Simulator measures there.
  const lastStatus = useRef({ outer: 174, inner: 124 });
  const display = bar?.division ? "inner" : "outer";
  if (bar?.status) lastStatus.current[display] = bar.status[1] + bar.status[3];
  const [thumb, setThumb] = useState<HTMLElement | null>(null);
  const pillShown = !fold && stack.atRoot && !keyboardUp;
  const [primary, setPrimary] = useState<PrimaryAction | null>(null);
  // The row of what the Fold's detail pane shows is marked; a phone marks none.
  const { detail } = stack;
  const bookmarkId = fold && (detail?.name === "bookmark" || detail?.name === "reader") ? detail.bookmarkId : null;
  const postId = fold && detail?.name === "post" ? detail.itemId : null;
  const selected = useMemo(() => ({ bookmarkId, postId }), [bookmarkId, postId]);
  const shareIntake = useShareIntake();

  const phone = useMemo<Phone>(
    () => ({ app, stack, sheets, fold, hand, setHand, bar, column, thumb, keyboardUp, pillShown, setBottomLift, selected, primary, setPrimary, shareIntake }),
    [app, stack, sheets, fold, hand, setHand, bar, column, thumb, keyboardUp, pillShown, selected, primary, shareIntake],
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
        {/* On the Fold the cluster stands above the rail, on the side the person holds: not in the headers.
            On iPhone Duo it stays in the headers: the rail's column is the system's. */}
        <AccountSlot.Provider value={fold && !bar ? null : account}>
          <div
            className="phone"
            data-phone
            data-fold={fold || undefined}
            data-hand={hand}
            data-pill={(pillShown && !bar) || undefined}
            data-vbar={bar?.edge}
            data-keyboard={keyboardUp || undefined}
            data-glass={flatGlass(system) ? "flat" : undefined}
            data-text-large={largeText(system) || undefined}
            style={{ "--ph-lift": `${bottomLift}px`, "--ph-text-scale": system.textScale, ...barStyle(bar, lastStatus.current[display]) } as CSSProperties}
          >
            <div className="ph-main">
              <ScreenStack />
              {/* The bottom fade under the nav pill (iPhone Duo's outer display: under the list; triage's
                  own pill stands at the bottom there and stays clear, DO1). */}
              {pillShown && !(bar && stack.tab === "inbox") && <div className="ph-fade-bottom" aria-hidden="true" />}
            </div>
            {bar ? (
              <>
                {/* On the outer display the reader keeps the navigation beside its drop (DO2). */}
                <Rail account={null} hidden={!fold && !pillShown && !(stack.top?.name === "reader" && !keyboardUp)} thumb={setThumb} />
                <div ref={setColumn} className="ph-vbar-actions" data-vbar-actions />
              </>
            ) : fold ? (
              <Rail account={account} />
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
 * The vertical bar's geometry for phone.css (`data-vbar`): its column's left edge and width, where
 * its status block ends, and the fold's division on the inner display, in CSS pixels. `status` is
 * where the block ended last time: a fold or a rotation can report the column a moment before its
 * status block, and the slab and the actions must not slide under the clock meanwhile.
 */
function barStyle(bar: VerticalBar | null, status: number): Record<string, string> {
  if (!bar) return {};
  const [x, , width] = bar.column;
  const style: Record<string, string> = {
    "--vbar-x": `${x}px`,
    "--vbar-w": `${width}px`,
    "--vbar-status": `${status}px`,
  };
  if (bar.division) {
    style["--vbar-fold-start"] = `${bar.division[0]}px`;
    style["--vbar-fold-end"] = `${bar.division[0] + bar.division[2]}px`;
  }
  return style;
}

/** The phone root each dressed box follows while its snackbar is in a dialog. */
const following = new WeakMap<HTMLElement, MutationObserver>();

/**
 * The shared dialogs stand outside the phone's root, and the snackbar is styled under it (`.phone`,
 * its data and variables). In a dialog its box takes them from the root and follows the root's changes
 * (the keyboard's lift, a Fold unfolded, the hand) for as long as it is there; at home, or once the
 * notice is gone, the box is bare again.
 */
function dressAsPhone(box: HTMLElement, inDialog: boolean) {
  following.get(box)?.disconnect();
  following.delete(box);
  const root = document.querySelector<HTMLElement>("[data-phone]");
  const copy = () => {
    for (const name of box.getAttributeNames()) if (name !== "style") box.removeAttribute(name);
    box.style.cssText = "display: contents";
    if (!inDialog || !root) return;
    for (const name of root.getAttributeNames()) if (name !== "style" && name !== "data-phone") box.setAttribute(name, root.getAttribute(name)!);
    box.style.cssText = `${root.style.cssText}; display: contents`;
  };
  copy();
  if (!inDialog || !root) return;
  const observer = new MutationObserver(copy);
  observer.observe(root, { attributes: true });
  following.set(box, observer);
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
  const slot = useRef<HTMLDivElement>(null);
  // Readable over an open dialog, such as Sync's: a modal one makes the rest of the screen inert.
  const place = useOverDialogs(slot, { on: !!notice, raise: notice, dress: dressAsPhone });
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
  return place(
    <div ref={slot} className="ph-snackbar-slot">
      <Snackbar
        key={keys.current.get(notice)}
        text={notice.text}
        alert={notice.alert}
        icon={notice.icon === "trash" ? Trash2 : undefined}
        action={action}
        onTimeout={close}
      />
    </div>,
  );
}

/**
 * Whether links shared from other apps arrive ({@link Phone.shareIntake}): the build's capability,
 * then the app's answer, asked once; a failed ask is tried once more a little later.
 */
function useShareIntake(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!capabilities.share_intake) return;
    let live = true;
    let again: ReturnType<typeof setTimeout> | undefined;
    const ask = (tries: number) =>
      api.shareIntakeReady().then(
        (answer) => live && setReady(answer),
        () => {
          if (live && tries > 0) again = setTimeout(() => void ask(tries - 1), 2000);
        },
      );
    void ask(1);
    return () => {
      live = false;
      clearTimeout(again);
    };
  }, []);
  return ready;
}
