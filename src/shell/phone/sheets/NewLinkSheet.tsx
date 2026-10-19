import { type CSSProperties, type FormEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { CircleX, Link, Rss } from "lucide-react";
import { clipboardLink, siteBookmarks } from "../../../components/library/AddSheet";
import { type Destination, draftBookmark, previewedBookmark, samePage, typedLink, webLink } from "../../../services/addLink";
import { describeError } from "../../../services/errors";
import { subscribeFeed } from "../../../services/feeds";
import { type FeedOffer, feedOffer, feedRate, primaryAction, useFeedPreview, useLinkPreview } from "../../../services/linkPreview";
import { siteName } from "../../../services/cover";
import type { Bookmark } from "../../../types";
import { usePhone } from "../PhoneContext";
import { Button } from "../ui/buttons";
import { Segmented, Toggle } from "../ui/controls";
import { PhIcon } from "../ui/icons";
import { Sheet, useCloseSheet } from "../ui/Sheet";
import { cameWhole } from "./editingLogic";
import { LinkThumb } from "./LinkThumb";
import "./editing.css";

/** `url`: a link to start from (a pasted or shared one). */
export type NewLinkSheetProps = { url?: string };

/** What the phone saves a new link to (N1): sorted later in Inbox, or straight into the library. */
type SaveTo = Extract<Destination, "inbox" | "library">;

/**
 * N1 New link: a detached sheet (the keyboard lifts it through `--safe-bottom`, so "Save link"
 * stays above it). The desktop's AddSheet behind it: the link's page asked once it came whole (a
 * paste, the clipboard on open), "already in your library" with Show it, the site's feed with a
 * Follow toggle (followed after the link is saved; a bare feed is followed, not saved), errors in
 * the sheet with everything kept. Saved to Inbox (the default, as N1) or the Library.
 */
export function NewLinkSheet({ props }: { props: NewLinkSheetProps }) {
  const { app, stack } = usePhone();
  const { t } = app;
  const close = useCloseSheet();
  const formId = useId();
  const field = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(props.url ?? "");
  /** The text as it came whole: only such a link gets its page asked (AddSheet, privacy policy). */
  const [pasted, setPasted] = useState<string | null>(props.url ?? null);
  const pasting = useRef(false);
  const [saveTo, setSaveTo] = useState<SaveTo>("inbox");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<Bookmark | null>(null);
  const [existing, setExisting] = useState<{ url: string; bookmark: Bookmark | null } | null>(null);

  // A link in the clipboard fills the field, when the system lets the app read it without asking.
  useEffect(() => {
    if (props.url) return;
    let live = true;
    void clipboardLink().then((link) => {
      if (!live || !link) return;
      setText((now) => (now ? now : link));
      setPasted((now) => now ?? link);
    });
    return () => {
      live = false;
    };
  }, [props.url]);

  const url = useMemo(() => webLink(typedLink(text)), [text]);
  const href = url?.href ?? "";

  // Already in the library? Read locally, never sent anywhere.
  useEffect(() => {
    if (!url) return setExisting(null);
    let live = true;
    const timer = window.setTimeout(() => {
      void siteBookmarks(url).then((items) => live && setExisting({ url: href, bookmark: items.find((b) => samePage(b.url, href)) ?? null }));
    }, 220);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
    // `url` follows `href`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [href]);

  const linkPreview = useLinkPreview(pasted !== null && pasted === text ? url : null);
  const [follow, setFollow] = useState(false);
  const [followedUid, setFollowedUid] = useState<string | null>(null);
  useEffect(() => {
    setFollow(false);
    setFollowedUid(null);
  }, [href]);
  const bare = linkPreview.state === "done" && !!linkPreview.page?.is_feed;
  const asked = feedOffer(linkPreview, 0, follow, { state: "idle" });
  const feedPreview = useFeedPreview(asked.kind === "offer" || asked.kind === "feed" ? asked.candidate : null, follow || bare);
  const offer: FeedOffer = followedUid
    ? { kind: "followed", uid: followedUid, site: asked.kind === "offer" ? asked.site : "" }
    : feedOffer(linkPreview, 0, follow, feedPreview);
  const primary = primaryAction(offer);
  /** A bare feed is followed, not saved: no place to save to. */
  const feedOnly = primary === "follow";

  const known = existing && existing.url === href ? existing : null;
  const there = saved ?? known?.bookmark ?? null;

  const change = (value: string) => {
    if (pasting.current || cameWhole(text, value)) setPasted(value);
    pasting.current = false;
    setText(value);
    setError("");
    setSaved(null);
  };

  /** The link is being looked up: the primary button waits, so it never saves a feed's address as a page. */
  const asking = !!url && pasted === text && linkPreview.state === "looking";

  const save = async () => {
    const link = typedLink(text);
    if (busy || asking) return;
    if (!link) return field.current?.focus();
    const candidate = offer.kind === "offer" || offer.kind === "feed" ? offer.candidate : null;
    const following = candidate && (primary === "saveFollow" || primary === "follow") ? candidate : null;
    const already = !!there && samePage(there.url, link);
    // Known to be there: saving would change nothing; the sheet says so and offers it.
    if (already && !following) return;
    setBusy(true);
    setError("");
    try {
      if (feedOnly && following) {
        await subscribeFeed(following.url, null, "feeds");
        close();
        return;
      }
      if (already && following) {
        setFollowedUid((await subscribeFeed(following.url, null, "feeds")).uid);
        return;
      }
      const added = await app.saveLink({
        url: link,
        collectionId: saveTo === "inbox" ? null : app.filters.collectionId,
        tags: [],
        destination: saveTo,
      });
      if (added.existing) {
        setText(link);
        setSaved(added.bookmark);
        return;
      }
      // The bookmark first, then the subscription (plan §6.5, as on the desktop).
      if (following) await subscribeFeed(following.url, null, "feeds");
      close();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save();
  };

  const page = linkPreview.state === "done" && !bare ? linkPreview.page : undefined;
  const draft = url && (there ?? (page ? previewedBookmark(url, page.metadata) : draftBookmark(url)));
  const looking = !!url && !there && (!known || (pasted === text && linkPreview.state === "looking"));

  const rate = offer.kind === "offer" || offer.kind === "feed" ? (offer.preview ? feedRate(offer.preview) : null) : null;
  const feedLine =
    offer.kind === "offer" || offer.kind === "feed"
      ? offer.status === "unreadable"
        ? t("add.feedUnreadable")
        : offer.status === "looking"
          ? t("add.feedLooking")
          : offer.status === "ready" && rate
            ? t(rate.key, { count: rate.count })
            : t("phone.newLink.feedLine")
      : "";

  const primaryLabel = busy
    ? t(feedOnly ? "add.feedFollowing" : "add.saving")
    : t(primary === "follow" ? "add.feedFollow" : primary === "saveFollow" ? "add.feedSaveFollow" : "add.save");

  return (
    <Sheet
      label={t("phone.newLink.title")}
      title={t("phone.newLink.title")}
      footer={
        <Button kind="primary" block type="submit" form={formId} disabled={busy || asking}>
          {primaryLabel}
        </Button>
      }
    >
      <form id={formId} className="nl-form" noValidate onSubmit={submit}>
        <label className="nl-url">
          <PhIcon icon={Link} at="field" />
          <input
            ref={field}
            autoFocus
            type="url"
            inputMode="url"
            enterKeyHint="go"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label={t("add.url")}
            placeholder={t("add.placeholder")}
            value={text}
            onPaste={() => {
              // The paste's own input follows in this task; one that changed nothing must not
              // leave the next typed character counted as a paste.
              pasting.current = true;
              window.setTimeout(() => {
                pasting.current = false;
              });
            }}
            onChange={(e) => change(e.target.value)}
            onKeyDown={(e) => {
              // On a phone links are typed more than pasted: «Go» on a typed link asks for it as a
              // paste does (its preview and feed, owner 19 October); «Go» again saves it.
              if (e.key !== "Enter" || !url || pasted === text) return;
              e.preventDefault();
              setPasted(text);
            }}
          />
          {text && (
            <button
              type="button"
              className="ph-circle ph-hit"
              style={{ "--ph-circle": "36px" } as CSSProperties}
              aria-label={t("phone.kit.clear")}
              onClick={() => {
                change("");
                setPasted(null);
                field.current?.focus();
              }}
            >
              <PhIcon icon={CircleX} at="field" />
            </button>
          )}
        </label>

        {error ? (
          <p role="alert" className="nl-note" data-tone="error">
            {error}
          </p>
        ) : (
          text.trim() && !url && <p className="nl-note">{t("add.notLink")}</p>
        )}

        {!feedOnly && draft && (looking ? (
          <div className="nl-card" data-preview="loading" aria-hidden="true">
            <span className="nl-shimmer ed-thumb" style={{ "--ed-thumb": "64px" } as CSSProperties} />
            <span className="nl-card-text">
              <span className="nl-shimmer" style={{ height: 12, width: "70%" }} />
              <span className="nl-shimmer" style={{ height: 10, width: "40%", marginTop: 6 }} />
            </span>
          </div>
        ) : (
          <div className="nl-card" data-preview={there ? "existing" : "new"}>
            <LinkThumb bookmark={draft} size={64} />
            <span className="nl-card-text">
              <b data-user-text>{there ? there.title || there.url : draft.title || siteName(draft)}</b>
              <span className="ph-meta" data-user-text>
                {there ? t("add.existing") : draft.domain}
              </span>
            </span>
            {there && (
              <Button
                compact
                onClick={() => {
                  close();
                  app.setEditing(there);
                }}
              >
                {t("add.show")}
              </Button>
            )}
          </div>
        ))}

        {offer.kind !== "none" && (
          <div className="nl-feed" data-feed-offer={offer.kind === "followed" ? "followed" : offer.status}>
            <span className="nl-feed-icon">
              <PhIcon icon={Rss} size={22} strokeWidth={1.85} />
            </span>
            <span className="nl-feed-text">
              <b data-user-text>
                {offer.kind === "followed"
                  ? t("add.feedFollowed")
                  : offer.kind === "feed"
                    ? t("add.feedFollowTitle", { title: offer.title })
                    : t("add.feedHas", { site: offer.site })}
              </b>
              {offer.kind !== "followed" && (
                <span className="ph-meta" data-tone={offer.status === "unreadable" ? "warn" : undefined}>
                  {feedLine}
                </span>
              )}
            </span>
            {offer.kind === "offer" && <Toggle checked={follow} onChange={setFollow} label={t("add.feedToggle", { site: offer.candidate.title || offer.site })} />}
            {offer.kind === "followed" && (
              <Button
                compact
                onClick={() => {
                  close();
                  stack.selectTab("feeds");
                  app.openFeeds(offer.uid);
                }}
              >
                {t("add.feedShow")}
              </Button>
            )}
          </div>
        )}

        {!feedOnly && (
          <div className="nl-saveto">
            <span>{t("phone.newLink.saveTo")}</span>
            <Segmented<SaveTo>
              label={t("phone.newLink.saveTo")}
              value={saveTo}
              onChange={setSaveTo}
              options={[
                { value: "inbox", label: t("nav.inbox") },
                { value: "library", label: t("import.library") },
              ]}
            />
          </div>
        )}
      </form>
    </Sheet>
  );
}
