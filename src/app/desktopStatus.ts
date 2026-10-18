import { useEffect, useState } from "react";
import { capabilities } from "../platform/capabilities";
import { api, desktopApi } from "../services/api";
import { openRequests } from "../services/openRequests";
import type { CaptureStatus, UpdateStatus } from "../types";
import type { Surfaces } from "./surfaces";

/** «Нет связи 3 дня» depends on the clock: the status is read again this often. */
const CAPTURE_REFRESH_MS = 5 * 60 * 1000;

/**
 * What only a desktop reports: the app's own update (NP-038, sheet 42) and the browsers' capture
 * (NP-016). The desktop shell reads them; a phone's store updates the app and a phone has no
 * browser extension to hear from (NP-151).
 */
export function useDesktopStatus() {
  /** Checked by Rust; the version that runs and the system for the dialog. */
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [appVersion, setAppVersion] = useState("");
  const [linux, setLinux] = useState(false);
  const [capture, setCapture] = useState<CaptureStatus | null>(null);
  useEffect(() => {
    void api.getVersion().then(setAppVersion).catch(() => {});
    const desktop = desktopApi;
    if (capabilities.updates !== "self" || !desktop) return;
    const off = desktop.onUpdateStatus(setUpdate);
    void desktop.getUpdateStatus().then(setUpdate).catch(() => {});
    // The password texts of the update dialog are for the .deb and .rpm: an AppImage replaces its own file (NP-116).
    void desktop.getDesktop().then((system) => setLinux(system.linux && !system.appimage)).catch(() => {});
    return off;
  }, []);
  useEffect(() => {
    const desktop = desktopApi;
    if (!capabilities.browser_capture || !desktop) return;
    // The app learns about browsers when their extensions write (NP-016).
    const refresh = () => void desktop.getCaptureStatus().then(setCapture).catch(() => {});
    const off = desktop.onCaptureStatus(setCapture);
    refresh();
    const timer = window.setInterval(refresh, CAPTURE_REFRESH_MS);
    window.addEventListener("focus", refresh);
    return () => {
      off();
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  return { update, setUpdate, appVersion, linux, capture, setCapture };
}

export type DesktopStatus = ReturnType<typeof useDesktopStatus>;

/**
 * The first close without a tray explains that the app keeps running (NP-096). A list dialog that
 * downloads or imports holds it until the person closes the dialog, so the result is seen; an idle
 * one is closed.
 */
export function useCloseToBackground({ list, setSurface }: Pick<Surfaces, "list" | "setSurface">) {
  const [backgroundWaits, setBackgroundWaits] = useState<"now" | "list" | null>(null);
  useEffect(() => desktopApi?.onCloseToBackground(() => setBackgroundWaits(openRequests.busy() ? "list" : "now")), []);
  useEffect(() => {
    if (!backgroundWaits || (backgroundWaits === "list" && list.request)) return;
    setBackgroundWaits(null);
    openRequests.done();
    setSurface("background");
  }, [backgroundWaits, list.request]);
}
