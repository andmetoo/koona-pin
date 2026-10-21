import { useEffect, useRef } from "react";
import { usePhone } from "../PhoneContext";

/** The app's surfaces the phone shows as sheets of its own, not as the desktop's dialogs. */
const SHEET_SURFACES = ["supporter", "signIn", "plan", "deleteAccount"] as const;
type SheetSurface = (typeof SHEET_SURFACES)[number];
const isSheetSurface = (surface: unknown): surface is SheetSurface => SHEET_SURFACES.includes(surface as SheetSurface);

/**
 * Supporter, sign-in and the plan on a phone (NP-072b): `app.surface` set to one of them, by shared
 * code (the Sync dialog's Renew and Sign in) or the phone's own (A1, the reader's Aa), opens its
 * sheet and lets the surface go, as "add" opens the newLink sheet. One of them replaces another, as
 * the desktop's dialogs do ("I'm already a Supporter" → the sign-in); a sheet of the kind already
 * open stays. The plan needs a plan. In every phone build they take the place of "You & sync", the
 * sheet they are opened from, so nothing is dimmed twice (NP-154, P1–P10); any other sheet (the
 * reader's look) and the screens (Settings) stay under them.
 */
export function useSupporterSheets() {
  const { app, sheets } = usePhone();
  const { surface, setSurface, supporter } = app;
  const hasPlan = !!supporter?.plan;
  const opened = useRef<number | null>(null);
  useEffect(() => {
    if (!isSheetSurface(surface)) return;
    setSurface(null);
    if ((surface === "plan" && !hasPlan) || sheets.isOpen(surface)) return;
    sheets.closeKind("you");
    if (opened.current !== null) sheets.close(opened.current);
    opened.current = sheets.open({ kind: surface, props: {} });
  }, [surface, setSurface, sheets, hasPlan]);
}
