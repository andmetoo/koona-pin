import { useAppState } from "../../app/appState";
import { useCloseToBackground, useDesktopStatus } from "../../app/desktopStatus";
import { useShortcuts } from "../../app/shortcuts";
import { BackgroundDialog } from "../../components/library/Dialogs";
import { AssistantDialog } from "../../components/settings/AssistantDialog";
import { Workspace } from "./Workspace";
import { UpdateDialog } from "../../components/UpdateDialog";
import { api, desktopOnly } from "../../services/api";
import { describeError } from "../../services/errors";
import { offer } from "../../services/update";
import { WindowBar } from "./WindowBar";

/**
 * The desktop's window (NP-072a): the library with the sidebar and the toolbar, under the window bar
 * of a frameless window, with what only a desktop has: the app's own update and its dialog, the
 * browsers' capture status, the dialog of the first close without a tray (NP-096), the AI
 * assistants' dialog (NP-091) and the window's keys, `Ctrl Q` among them.
 */
export function DesktopShell() {
  const desktop = useDesktopStatus();
  const app = useAppState(desktop);
  useCloseToBackground(app);
  useShortcuts(app);
  const { surface, setSurface, say, copy } = app;
  const { update, appVersion, linux } = desktop;
  const offered = offer(update);
  return (
    <Workspace
      app={app}
      windowBar={<WindowBar />}
      overlays={
        <>
          {surface === "background" && <BackgroundDialog onClose={() => setSurface(null)} />}
          {surface === "update" && offered && (
            <UpdateDialog
              update={offered}
              current={appVersion}
              linux={linux}
              onClose={() => setSurface(null)}
              onInstall={() => void desktopOnly().installUpdate().catch((err) => say(describeError(err), true))}
              onCancel={() => void desktopOnly().cancelUpdate().catch((err) => say(describeError(err), true))}
              onOpen={(url) => void api.openUrl(url).catch((err) => say(describeError(err), true))}
            />
          )}
          {surface === "assistant" && (
            <AssistantDialog onCopy={(text) => void copy(text)} onNotice={say} onClose={() => setSurface(null)} />
          )}
        </>
      }
    />
  );
}
