import { ReactNode, useState } from "react";
import { ArrowRightLeft, BellRing, CheckCheck, Copy, ExternalLink, Inbox, Pencil, Rss, UserMinus } from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { Feed, FeedDestination } from "../../types";
import { describeError } from "../../services/errors";
import { acceptFeedMove, feedName, markFeedRead, unsubscribeFeed, updateFeed } from "../../services/feeds";
import { MenuEntry } from "../ui/Menu";
import { Dialog } from "../ui/Dialog";
import { Field } from "../ui/Controls";
import { Button } from "../ui/Button";
import { ConfirmDialog, Footer } from "../library/Dialogs";

/** What a feed's row menu does (NP-132); `markRead` with null marks every feed. */
export interface FeedActions {
  rename: (feed: Feed) => void;
  destination: (feed: Feed, destination: FeedDestination) => void;
  markRead: (feed: Feed | null) => void;
  /** A feed whose fetches found it at a new address: follow it there (plan §4.3). */
  updateAddress: (feed: Feed) => void;
  copy: (feed: Feed) => void;
  openSite: (feed: Feed) => void;
  unfollow: (feed: Feed) => void;
}

const DESTINATIONS: { value: FeedDestination; icon: typeof Rss }[] = [
  { value: "feeds", icon: Rss },
  { value: "inbox", icon: Inbox },
  { value: "notify", icon: BellRing },
];

/** The row menu of a feed in the sidebar: right click or «…» (NP-132). */
export function feedMenu(feed: Feed, t: TFunction, actions: FeedActions): MenuEntry[] {
  return [
    { id: "rename", label: t("feeds.menu.rename"), icon: Pencil, onSelect: () => actions.rename(feed) },
    {
      id: "destination",
      label: t("feeds.menu.destination"),
      icon: Inbox,
      submenu: DESTINATIONS.map(({ value, icon }) => ({
        id: `destination-${value}`,
        label: t(`feeds.destinations.${value}`),
        icon,
        radio: true,
        checked: feed.destination === value,
        onSelect: () => actions.destination(feed, value),
      })),
    },
    { id: "markRead", label: t("feeds.menu.markRead"), icon: CheckCheck, disabled: feed.unread === 0, onSelect: () => actions.markRead(feed) },
    "separator",
    ...(feed.health.state === "moved"
      ? [{ id: "updateAddress", label: t("feeds.menu.updateAddress"), icon: ArrowRightLeft, onSelect: () => actions.updateAddress(feed) }]
      : []),
    { id: "copy", label: t("feeds.menu.copy"), icon: Copy, onSelect: () => actions.copy(feed) },
    { id: "site", label: t("feeds.menu.openSite"), icon: ExternalLink, disabled: !feed.site_url, onSelect: () => actions.openSite(feed) },
    "separator",
    { id: "unfollow", label: t("feeds.menu.unfollow"), icon: UserMinus, onSelect: () => actions.unfollow(feed) },
  ];
}

/**
 * The feed actions with their dialogs (NP-132): Rename asks for the name, Unfollow… is
 * confirmed. `dialogs` goes into the page; notices go through the app's own.
 */
export function useFeedActions({
  onNotice,
  onOpen,
  onCopy,
  onUnfollowed,
}: {
  onNotice: (text: string, alert?: boolean) => void;
  onOpen: (url: string) => void;
  onCopy: (text: string) => void;
  onUnfollowed: (feed: Feed) => void;
}): { actions: FeedActions; dialogs: ReactNode } {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState<Feed | null>(null);
  const [unfollowing, setUnfollowing] = useState<Feed | null>(null);
  const failed = (err: unknown) => onNotice(describeError(err), true);
  const actions: FeedActions = {
    rename: setRenaming,
    destination: (feed, destination) =>
      void updateFeed(feed.uid, null, destination).then(
        () => onNotice(t("feeds.notice.destination", { name: feedName(feed), place: t(`feeds.destinations.${destination}`) })),
        failed,
      ),
    // Up to the newest post the sidebar knew of: one a check brought since stays new.
    markRead: (feed) =>
      void markFeedRead(feed?.uid ?? null, feed?.newest_at ?? null).then(
        (count) => onNotice(count ? t("feeds.notice.markedRead", { count }) : t("feeds.notice.allRead")),
        failed,
      ),
    updateAddress: (feed) =>
      void acceptFeedMove(feed.uid).then(() => onNotice(t("feeds.notice.addressUpdated", { name: feedName(feed) })), failed),
    copy: (feed) => onCopy(feed.url),
    openSite: (feed) => feed.site_url && onOpen(feed.site_url),
    unfollow: setUnfollowing,
  };
  const dialogs = (
    <>
      {renaming && <RenameDialog feed={renaming} onClose={() => setRenaming(null)} />}
      {unfollowing && (
        <ConfirmDialog
          title={t("feeds.unfollow.title", { name: feedName(unfollowing) })}
          text={t("feeds.unfollow.text")}
          confirm={t("feeds.unfollow.confirm")}
          onClose={() => setUnfollowing(null)}
          onConfirm={async () => {
            await unsubscribeFeed(unfollowing.uid);
            setUnfollowing(null);
            onUnfollowed(unfollowing);
            onNotice(t("feeds.notice.unfollowed", { name: feedName(unfollowing) }));
          }}
        />
      )}
    </>
  );
  return { actions, dialogs };
}

/** «Rename…»: the person's own name for the feed; empty goes back to the feed's own. */
function RenameDialog({ feed, onClose }: { feed: Feed; onClose: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(feedName(feed));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title={t("feeds.rename.title")} onClose={() => !busy && onClose()} width={400}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          updateFeed(feed.uid, name.trim(), null).then(onClose, (err) => {
            setBusy(false);
            setError(describeError(err));
          });
        }}
      >
        <Field label={t("feeds.rename.name")} hint={t("feeds.rename.hint")} error={error ?? undefined}>
          {(id, describedBy) => (
            <input
              id={id}
              autoFocus
              aria-describedby={describedBy}
              value={name}
              placeholder={feed.feed_title ?? undefined}
              onChange={(e) => setName(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              className="field"
            />
          )}
        </Field>
        <Footer>
          <Button variant="primary" size="lg" type="submit" disabled={busy}>
            {t("feeds.rename.save")}
          </Button>
        </Footer>
      </form>
    </Dialog>
  );
}
