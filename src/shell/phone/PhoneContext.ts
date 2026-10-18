import { createContext, useContext, useEffect } from "react";
import type { AppState } from "../../app/appState";
import type { PhoneStack } from "./navigation/usePhoneStack";
import type { Sheets } from "./sheets/useSheets";

/**
 * What every phone screen and sheet gets from the shell (NP-072b): the app's state (everything
 * `useAppState` returns: the library, filters, editing, notices, Supporter, sync…), the stack of
 * screens, the sheets, and the state of the chrome.
 */
export type Phone = {
  app: AppState;
  stack: PhoneStack;
  sheets: Sheets;
  /** The window is wider than 840 dp (an unfolded Fold): the rail instead of the nav pill. */
  fold: boolean;
  /** The on-screen keyboard is up. */
  keyboardUp: boolean;
  /** The nav pill shows: a tab's root, no keyboard, not on the Fold. */
  pillShown: boolean;
  /** Raises the snackbar above a screen's own floating bar (the decision pill), in px. */
  setBottomLift: (px: number) => void;
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
