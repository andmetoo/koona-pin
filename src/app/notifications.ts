import type { TFunction } from "i18next";
import { Import, Link, RefreshCw, TriangleAlert, WifiOff } from "lucide-react";
import { InboxTray } from "../components/icons";
import type { AppNotification } from "../components/shell/NotificationCenter";
import type { usePreviewRefresh } from "../hooks/usePreviewRefresh";
import { problemBanner } from "../services/capture";
import { feedNotifications } from "../services/feedNotifications";
import type { Bookmark, CaptureStatus, Feed, LibraryCounts } from "../types";

/** Above this many the inbox's line does not promise «about a minute». */
export const QUICK_INBOX = 20;

/** What waits in the inbox, said once for the notification centre and the Inbox section's pill. */
export function inboxLine(counts: LibraryCounts, t: TFunction): string {
  return [
    counts.inbox_imported >= counts.inbox
      ? t("notifications.inboxFromImport")
      : counts.inbox_imported > 0
        ? t("notifications.inboxImported", { count: counts.inbox_imported })
        : "",
    counts.inbox > QUICK_INBOX
      ? t("notifications.inboxMany")
      : counts.inbox === 1
        ? t("notifications.inboxTextOne")
        : t("notifications.inboxText"),
  ]
    .filter(Boolean)
    .join(" ");
}

type Previews = Pick<
  ReturnType<typeof usePreviewRefresh>,
  "run" | "running" | "resultShown" | "handedOff" | "stop" | "dismiss" | "dismissHandedOff"
>;

/**
 * The notification centre (2026-10-16): the inbox waiting, the import offer and a browser that can't
 * send bookmarks, behind the bell in the sidebar instead of banners over the list; the feeds' own
 * (NP-133) and the refresh of previews in the background.
 */
export function notificationsOf(
  {
    capture,
    counts,
    inboxHidden,
    inboxThumbs,
    importOffer,
    feeds,
    previews,
  }: {
    capture: CaptureStatus | null;
    counts: LibraryCounts;
    inboxHidden: boolean;
    inboxThumbs: Bookmark[];
    importOffer: boolean;
    feeds: Feed[] | null;
    previews: Previews;
  },
  on: {
    browserDetails: () => void;
    sortInbox: () => void;
    hideInbox: () => void;
    importOffer: () => void;
    hideImportOffer: () => void;
    openFeeds: (uid: string | null) => void;
    unfollow: (uid: string) => void;
    openLinks: () => void;
  },
  t: TFunction,
): AppNotification[] {
  const notifications: AppNotification[] = [];
  if (capture?.state === "failing")
    notifications.push({
      key: `capture:${capture.problem ?? "channel"}`,
      kind: "problem",
      icon: TriangleAlert,
      title: t("browser.failing"),
      text: problemBanner(capture, t),
      action: { label: t("browser.details"), run: on.browserDetails },
      help: "savingFails",
    });
  if (counts.inbox > 0 && !inboxHidden)
    notifications.push({
      // A newer bookmark makes it a new notification, unread again.
      key: `inbox:${counts.inbox_newest ?? counts.inbox}`,
      kind: "inbox",
      icon: InboxTray,
      title: t("notifications.inboxTitle", { count: counts.inbox }),
      text: inboxLine(counts, t),
      at: counts.inbox_newest,
      thumbs: inboxThumbs,
      action: { label: t("inbox.sort"), run: on.sortInbox },
      dismiss: { label: t("inbox.hide"), run: on.hideInbox },
    });
  if (importOffer)
    notifications.push({
      key: "importOffer",
      kind: "offer",
      icon: Import,
      title: t("importOffer.label"),
      text: t("importOffer.text"),
      action: { label: t("importOffer.action"), run: on.importOffer },
      dismiss: { label: t("importOffer.hide"), run: on.hideImportOffer },
    });
  // The feeds' own (NP-133): new posts of feeds that notify, feeds that stopped updating.
  // «Read» opens All feeds: the page shows one feed or all of them, not a few (NP-132).
  notifications.push(
    ...feedNotifications(
      feeds ?? [],
      {
        onRead: (uids) => on.openFeeds(uids.length === 1 ? uids[0] : null),
        onShow: (uid) => on.openFeeds(uid),
        onUnfollow: on.unfollow,
      },
      t,
    ),
  );
  const refreshRun = previews.run;
  if (refreshRun && previews.running)
    notifications.push({
      key: `previews:${refreshRun.started_at}:running`,
      kind: "task",
      icon: RefreshCw,
      title: t("notifications.refreshRunning", { done: refreshRun.done, total: refreshRun.total }),
      text: t("notifications.refreshRunningText"),
      progress: refreshRun.total ? refreshRun.done / refreshRun.total : 0,
      // Unread once it ends, under the key of its result.
      quiet: true,
      action: { label: t("notifications.refreshStop"), run: () => void previews.stop(), stay: true },
    });
  else if (refreshRun && previews.resultShown)
    notifications.push({
      key: `previews:${refreshRun.started_at}:${refreshRun.state}`,
      kind: "task",
      icon: refreshRun.state === "offline" ? WifiOff : RefreshCw,
      title: t(
        refreshRun.state === "offline"
          ? "notifications.refreshOffline"
          : refreshRun.state === "stopped"
            ? "notifications.refreshStopped"
            : "notifications.refreshDone",
      ),
      text:
        refreshRun.state === "offline"
          ? t("notifications.refreshOfflineText", { done: refreshRun.done, total: refreshRun.total })
          : t(refreshRun.check_ids.length ? "notifications.refreshResultChecking" : "notifications.refreshResult", {
              updated: refreshRun.updated,
              unchanged: refreshRun.unchanged,
              failed: refreshRun.failed,
            }),
      dismiss: { label: t("notifications.refreshHide"), run: previews.dismiss },
    });
  const handedOff = previews.handedOff;
  if (handedOff)
    notifications.push({
      key: `previews:${handedOff.key}:links`,
      kind: "task",
      icon: Link,
      title: handedOff.gone + handedOff.moved ? t("links.finished", { count: handedOff.gone + handedOff.moved }) : t("links.allOpenTitle"),
      text: [
        handedOff.gone ? t("notifications.linksCount", { label: t("links.group_gone"), count: handedOff.gone }) : "",
        handedOff.moved ? t("notifications.linksCount", { label: t("links.group_moved"), count: handedOff.moved }) : "",
      ]
        .filter(Boolean)
        .join(" · "),
      action: handedOff.gone + handedOff.moved ? { label: t("notifications.linksShow"), run: on.openLinks } : undefined,
      dismiss: { label: t("notifications.refreshHide"), run: previews.dismissHandedOff },
    });
  return notifications;
}
