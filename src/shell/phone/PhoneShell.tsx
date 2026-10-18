import { useAppState } from "../../app/appState";
import { useShortcuts } from "../../app/shortcuts";
import { Workspace } from "../../components/shell/Workspace";

/**
 * A phone's app (NP-072a). For now the same library window as after NP-151 — the desktop's layout
 * with the phone's adjustments in app.css, without the window bar, the update, the browsers or the
 * tray — so a phone looks as it did. NP-072b replaces this body with the phone's own screens:
 * the navigation pill, the rail on an unfolded Fold, sheets and the Back stack.
 */
export function PhoneShell() {
  const app = useAppState(null);
  // A keyboard attached to a tablet or a phone keeps the library's keys, as after NP-151.
  useShortcuts(app);
  return <Workspace app={app} />;
}
