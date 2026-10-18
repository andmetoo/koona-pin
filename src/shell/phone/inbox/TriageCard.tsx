import { type CSSProperties, type HTMLAttributes, type ReactNode, type Ref, useMemo } from "react";
import { Ellipsis, Heart } from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePicture } from "../../../hooks/usePicture";
import { coverOf, monogram, siteName } from "../../../services/cover";
import { relativeTime } from "../../../services/relativeTime";
import type { Bookmark } from "../../../types";
import { CircleButton } from "../ui/buttons";

/**
 * The triage card (doc/mobile-design.md, Triage card; frame I1): paper r 28 with e2; the picture
 * inset 8 with r 20 and the site as an eyebrow over it — without a picture the site's cover
 * gradient with the site's name large, as the desktop's poster cover; the source row (favicon,
 * domain · time, heart, more), the title 21/27 and two lines of description. Opaque, two glyphs.
 * Only the card on screen (`place` 0) is live; the peeking ones behind it are drawn, not used.
 */
export function TriageCard({
  b,
  place,
  onFavorite,
  onMore,
  cardRef,
  overlay,
  ...rest
}: {
  b: Bookmark;
  /** 0 on screen, 1 and 2 peeking behind it. */
  place: number;
  onFavorite?: () => void;
  onMore?: () => void;
  cardRef?: Ref<HTMLElement>;
  /** Over the card, moving with it: the swipe's "Move to trash" or "Keep". */
  overlay?: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, "children">) {
  const { t, i18n } = useTranslation();
  const live = place === 0;
  const when = relativeTime(b.created_at, i18n.language);
  return (
    <article
      ref={cardRef}
      data-slot={place}
      data-triage-card={b.id}
      aria-hidden={live ? undefined : true}
      inert={live ? undefined : true}
      aria-label={live ? b.title || b.url : undefined}
      className="inb-card"
      {...rest}
    >
      <Cover b={b} />
      <div className="inb-source">
        <Favicon b={b} />
        <span className="inb-source-text">
          <span className="inb-domain" data-user-text>
            {b.domain}
          </span>
          {when && <span aria-hidden="true"> · </span>}
          {when}
        </span>
        <CircleButton
          kind="flat"
          icon={Heart}
          label={b.is_favorite ? t("card.unfavorite") : t("card.favorite")}
          aria-pressed={b.is_favorite}
          data-on={b.is_favorite || undefined}
          className="inb-heart"
          onClick={onFavorite}
          tabIndex={live ? undefined : -1}
        />
        <CircleButton kind="flat" icon={Ellipsis} label={t("phone.reader.more")} onClick={onMore} tabIndex={live ? undefined : -1} />
      </div>
      <h2 className="inb-title" data-user-text>
        {b.title || b.url}
      </h2>
      {b.description && (
        <p className="inb-desc" data-user-text>
          {b.description}
        </p>
      )}
      {overlay}
    </article>
  );
}

/** The picture, or the site's cover: its gradient, the site as an eyebrow, its name large. */
function Cover({ b }: { b: Bookmark }) {
  const picture = usePicture("bookmark-image", b.id, b.image_url);
  const cover = useMemo(() => coverOf(b.domain, b.url), [b.domain, b.url]);
  const name = siteName(b);
  return (
    <div
      className="inb-cover"
      data-picture={picture.src ? "" : undefined}
      style={{ "--from": cover.from, "--to": cover.to, "--angle": `${cover.angle}deg` } as CSSProperties}
    >
      {picture.src && (
        <img
          key={picture.src}
          src={picture.src}
          alt=""
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onError={picture.onError}
          onLoad={picture.onLoad}
        />
      )}
      <span className="inb-eyebrow ph-eyebrow" data-user-text>
        {picture.src ? name : b.domain}
      </span>
      {!picture.src && (
        <span className="inb-poster" data-user-text>
          {name}
        </span>
      )}
    </div>
  );
}

/** The site's icon in a small well, its letter when there is none. */
function Favicon({ b }: { b: Bookmark }) {
  const icon = usePicture("bookmark-icon", b.id, b.favicon_url);
  return (
    <span className="inb-favicon" aria-hidden="true">
      {icon.src ? (
        <img key={icon.src} src={icon.src} alt="" width={14} height={14} referrerPolicy="no-referrer" draggable={false} onError={icon.onError} onLoad={icon.onLoad} />
      ) : (
        monogram(b.domain, b.title)
      )}
    </span>
  );
}
