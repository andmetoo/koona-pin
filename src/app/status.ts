import { useEffect, useState } from "react";
import { api, isTauri } from "../services/api";
import { describeError } from "../services/errors";
import { preference } from "../services/preferences";
import type { AppSettings, BackupCopy, LibraryStatus, SupporterStatus, SyncStatus } from "../types";

/** Supporter (NP-066, sheet 45) and sync between a Supporter's devices (commercial/sync, sheet 46). */
export function useSupporter() {
  /** The plan as kept; no request behind it. */
  const [supporter, setSupporter] = useState<SupporterStatus | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  /** The Supporter badge's heart in the colour of the season; a perk the dialog turns off. */
  const [badge, setBadge] = useState(() => preference("supporterBadge", ["on", "off"], "on") === "on");
  useEffect(() => {
    void api.getSupporterStatus().then(setSupporter).catch(() => {});
    return api.onSupporterStatus(setSupporter);
  }, []);
  useEffect(() => {
    // An event newer than the first answer wins: the answer, late, would put an older state back.
    let heard = false;
    const stop = api.onSyncStatus((status) => {
      heard = true;
      setSync(status);
    });
    void api
      .getSyncStatus()
      .then((status) => heard || setSync(status))
      .catch(() => {});
    return stop;
  }, []);
  return { supporter, sync, setSync, badge, setBadge };
}

/**
 * The library's health after it opened: damage the background check found (sheet 33) with the
 * newest readable copy to offer, and a file the opening moved aside.
 */
export function useLibraryHealth() {
  const [damaged, setDamaged] = useState(false);
  /** The newest readable copy, offered by the damage banner (sheet 33). */
  const [latestCopy, setLatestCopy] = useState<BackupCopy | null>(null);
  /** Bumped after a restore: the settings count the copies again. */
  const [dataVersion, setDataVersion] = useState(0);
  const [movedAside, setMovedAside] = useState("");
  useEffect(() => {
    if (!isTauri()) return;
    // The background integrity check reports damage after the start.
    const apply = (status: LibraryStatus) => {
      if (status.state !== "ready") return;
      setDamaged(status.damaged);
      if (status.moved_aside) setMovedAside(status.moved_aside);
    };
    const off = api.onLibraryStatus(apply);
    void api.getLibraryStatus().then(apply).catch(() => {});
    return off;
  }, []);
  useEffect(() => {
    if (!damaged) return setLatestCopy(null);
    void api
      .listBackups()
      .then((copies) => setLatestCopy(copies.find((copy) => copy.bookmarks !== null) ?? null))
      .catch(() => {});
  }, [damaged]);
  return { damaged, latestCopy, dataVersion, setDataVersion, movedAside, setMovedAside };
}

/** Settings (NP-124 and before): read again each time the page opens. */
export function useAppSettings(page: string, say: (text: string, alert?: boolean) => void) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  useEffect(() => {
    if (page !== "settings") return;
    api
      .getAppSettings()
      .then(setSettings)
      .catch((err) => say(describeError(err), true));
  }, [page]);
  return { settings, setSettings };
}
