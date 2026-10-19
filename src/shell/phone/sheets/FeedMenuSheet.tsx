import { ArrowRightLeft, BellRing, Check, CheckCheck, Copy, ExternalLink, Inbox, Pencil, Rss, UserMinus } from "lucide-react";
import { usePhone } from "../PhoneContext";
import { PhIcon } from "../ui/icons";
import { Sheet, useCloseSheet } from "../ui/Sheet";
import { Shelf, ShelfRow } from "../ui/Shelf";
import { feedName } from "../../../services/feeds";
import { feedSite } from "../../../services/feedsView";
import type { FeedDestination } from "../../../types";

export type FeedMenuSheetProps = { feedUid: string };

const DESTINATIONS: { value: FeedDestination; icon: typeof Rss }[] = [
  { value: "feeds", icon: Rss },
  { value: "inbox", icon: Inbox },
  { value: "notify", icon: BellRing },
];

/**
 * A feed chip's long-press menu (F1): the desktop's feed menu (components/feeds/FeedMenu.tsx) as
 * a sheet — Rename and Unfollow ask in the app's own dialogs, the rest acts at once and says so.
 */
export function FeedMenuSheet({ props }: { props: FeedMenuSheetProps }) {
  const { app } = usePhone();
  const { t, feedActions } = app;
  const close = useCloseSheet();
  const feed = app.feeds?.find((f) => f.uid === props.feedUid);
  if (!feed) return <Sheet label={t("feeds.title")} title={t("feeds.title")} />;
  const run = (action: () => void) => () => {
    close();
    action();
  };
  return (
    <Sheet label={t("feeds.menu.label", { name: feedName(feed) })} title={feedName(feed)} subtitle={feedSite(feed)}>
      <Shelf className="-mx-4">
        <ShelfRow icon={Pencil} title={t("feeds.menu.rename")} onClick={run(() => feedActions.rename(feed))} />
        {feed.unread > 0 && <ShelfRow icon={CheckCheck} title={t("feeds.menu.markRead")} onClick={run(() => feedActions.markRead(feed))} />}
        {feed.health.state === "moved" && <ShelfRow icon={ArrowRightLeft} title={t("feeds.menu.updateAddress")} onClick={run(() => feedActions.updateAddress(feed))} />}
        <ShelfRow icon={Copy} title={t("feeds.menu.copy")} onClick={run(() => feedActions.copy(feed))} />
        {feed.site_url && <ShelfRow icon={ExternalLink} title={t("feeds.menu.openSite")} onClick={run(() => feedActions.openSite(feed))} />}
      </Shelf>
      <Shelf label={t("feeds.menu.destination")} className="-mx-4">
        {DESTINATIONS.map(({ value, icon }) => (
          <ShelfRow
            key={value}
            icon={icon}
            title={t(`feeds.destinations.${value}`)}
            trailing={
              feed.destination === value ? (
                <>
                  <PhIcon icon={Check} at="field" className="text-[var(--ph-accent)]" />
                  <span className="sr-only">{t("phone.feeds.chosen")}</span>
                </>
              ) : undefined
            }
            onClick={run(() => feed.destination !== value && feedActions.destination(feed, value))}
          />
        ))}
      </Shelf>
      <Shelf className="-mx-4">
        <ShelfRow icon={UserMinus} title={t("feeds.menu.unfollow")} onClick={run(() => feedActions.unfollow(feed))} />
      </Shelf>
    </Sheet>
  );
}
