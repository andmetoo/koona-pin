import { createContext, type Dispatch, type SetStateAction, useContext, useEffect, useRef } from "react";
import type { LucideIcon } from "lucide-react";
import type { AppState } from "../../app/appState";
import type { PhoneStack } from "./navigation/usePhoneStack";
import type { Sheets } from "./sheets/useSheets";

/**
 * The screen's main action on the Fold's rail (FL1: Read on a bookmark, FL2: Save on a post): a
 * flat accent circle in the rail's thumb part. A screen offers it with {@link usePrimaryAction}.
 */
export type PrimaryAction = {
  icon: LucideIcon;
  /** Its name for screen readers (the rail has no labels). */
  label: string;
  run: () => void;
  /** Done already (a post saved): the circle says so with `aria-pressed`. */
  pressed?: boolean;
};

/**
 * What every phone screen and sheet gets from the shell (NP-072b): the app's state (everything
 * `useAppState` returns: the library, filters, editing, notices, Supporter, sync…), the stack of
 * screens, the sheets, and the state of the chrome.
 */
export type Phone = {
  app: AppState;
  stack: PhoneStack;
  sheets: Sheets;
  /** The window is wider than 840 dp (an unfolded Fold): the rail instead of the nav pill, two panes. */
  fold: boolean;
  /** Which side the Fold's rail and main buttons are on (Settings → Layout, a long press on the rail). */
  hand: "right" | "left";
  setHand: (side: "right" | "left") => void;
  /** The on-screen keyboard is up. */
  keyboardUp: boolean;
  /** The nav pill shows: a tab's root, no keyboard, not on the Fold. */
  pillShown: boolean;
  /** Raises the snackbar above a screen's own floating bar (the decision pill), in px. */
  setBottomLift: (px: number) => void;
  /** On the Fold, the bookmark or post the detail pane shows: its row is marked selected. */
  selected: { bookmarkId: number | null; postId: number | null };
  /** The rail's primary action, set by the screen in the detail pane. */
  primary: PrimaryAction | null;
  setPrimary: Dispatch<SetStateAction<PrimaryAction | null>>;
};

export const PhoneContext = createContext<Phone | null>(null);

/** The phone shell's state, for a screen or a sheet. */
export function usePhone(): Phone {
  const phone = useContext(PhoneContext);
  if (!phone) throw new Error("usePhone outside the phone shell");
  return phone;
}

/**
 * While the calling screen shows, the snackbar sits `px` higher: above its own floating bar at
 * the bottom, as above triage's decision pill (60 + 12).
 */
export function useBottomLift(px: number, active = true) {
  const { setBottomLift } = usePhone();
  useEffect(() => {
    if (!active) return;
    setBottomLift(px);
    return () => setBottomLift(0);
  }, [px, active, setBottomLift]);
}

/**
 * While `active` (the calling screen shows in the Fold's detail pane), the rail offers `action` as
 * its primary circle; none when `action` is null. The latest `run` is called.
 */
export function usePrimaryAction(action: PrimaryAction | null, active: boolean) {
  const { setPrimary } = usePhone();
  const run = useRef(action?.run);
  run.current = action?.run;
  const icon = action?.icon;
  const label = action?.label;
  const pressed = action?.pressed;
  useEffect(() => {
    if (!active || !icon || !label) return;
    const own: PrimaryAction = { icon, label, pressed, run: () => run.current?.() };
    setPrimary(own);
    return () => setPrimary((now) => (now === own ? null : now));
  }, [active, icon, label, pressed, setPrimary]);
}
