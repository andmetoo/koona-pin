import { FormEvent, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ClipboardPaste, Link, Rss } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Bookmark, Collection, FeedDestination } from "../../types";
import { api } from "../../services/api";
import { describeError } from "../../services/errors";
import { shortcut } from "../../services/keys";
import { collectionColor } from "../../services/collections";
import { siteName } from "../../services/cover";
import { suggestFrom } from "../../services/triage";
import { Destination, domainOf, draftBookmark, linkFrom, previewedBookmark, samePage, typedLink, webLink } from "../../services/addLink";
import { subscribeFeed } from "../../services/feeds";
import { FeedOffer, feedOffer, feedRate, primaryAction, useFeedPreview, useLinkPreview } from "../../services/linkPreview";
import { relativeTime } from "../../services/relativeTime";
import { Icon } from "../icons";
import { Dot, Switch } from "../ui/Controls";
import { Preview } from "./Bookmarks";
import { TagInput } from "./Fields";

export interface NewLink {
  url: string;
  title?: string;
  collectionId: number | null;
  tags: string[];
  destination: Destination;
}

/** What the library already knows about the link's site: the same page, and where its other pages lie. */
interface Lookup {
  url: string;
  loading: boolean;
  existing: Bookmark | null;
  suggested: number | null;
}

/** Long enough for a paste to settle, short enough that the preview feels immediate. */
const LOOKUP_MS = 220;

/** The library's bookmarks of one site, for «already saved» and the suggested collection. Read locally, never sent anywhere. */
const siteBookmarks = (url: URL) =>
  api
    .getBookmarks({ domain: domainOf(url) }, { limit: 200 })
    .then((page) => page.items)
    .catch(() => [] as Bookmark[]);

/**
 * A web link in the clipboard, when the system lets the app read it without
 * asking (Chromium's `clipboard-read` already granted); otherwise none, and no
 * prompt. It stays on this computer: it is only shown, and compared with the library.
 */
async function clipboardLink(): Promise<string | null> {
  try {
    const state = await navigator.permissions?.query({ name: "clipboard-read" as PermissionName });
    if (state?.state !== "granted") return null;
    const link = linkFrom(await navigator.clipboard.readText());
    if (!link) return null;
    const known = await siteBookmarks(new URL(link));
    return known.some((b) => samePage(b.url, link)) ? null : link;
  } catch {
    return null;
  }
}

/**
 * Adding a link (2026-10-16, variant C of the prototype): a glass sheet near the
 * top of the window over a lightly blurred scrim, from «New link» in the sidebar
 * or `⌘N`. A large field with the focus; the clipboard's link offered when the
 * system allows reading it; a preview of the link; where it goes and into which
 * collection, the suggested one chosen; title and tags behind «Title and tags».
 * `Enter` saves, `Esc` closes; errors and «already saved» stay in the sheet.
 * One height from opening to an error (NP-118): the preview's slot is reserved.
 */
export function AddSheet({
  collections,
  destination: initialDestination,
  collectionId: initialCollection,
  onSave,
  onShow,
  onShowFeed,
  onClose,
}: {
  collections: Collection[];
  /** The section the person is in: Inbox and Reading open with their own destination. */
  destination: Destination;
  /** The collection on screen, if any: chosen over a suggestion. */
  collectionId: number | null;
  /** Saves the link; resolves with the bookmark already there, if it was, or null when saved. */
  onSave: (link: NewLink) => Promise<Bookmark | null>;
  /** «Show it» of a link already in the library. */
  onShow: (b: Bookmark) => void;
  /** «Show» of a site already followed (NP-133): the Feeds page on that feed. Without it, no button. */
  onShowFeed?: (uid: string) => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const ref = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const moreId = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  /**
   * The text as it came whole, by a paste or «Add it». Only such a link is asked for: a
   * link typed by hand passes through half-domains on the way (`example.c`), and none of
   * them should get a request (privacy policy: «the page you paste»).
   */
  const [pasted, setPasted] = useState<string | null>(null);
  const pasting = useRef(false);
  const [destination, setDestination] = useState<Destination>(initialDestination);
  /** Undefined until the person picks: then the section's collection or the suggestion. */
  const [picked, setPicked] = useState<number | null | undefined>(undefined);
  const [more, setMore] = useState(false);
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<Bookmark | null>(null);
  const [clip, setClip] = useState<string | null>(null);
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = busy ? () => {} : onClose;

  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.showModal();
    setOpen(true);
    return () => {
      dialog?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    let live = true;
    void clipboardLink().then((link) => live && setClip(link));
    return () => {
      live = false;
    };
  }, []);

  const url = useMemo(() => webLink(typedLink(text)), [text]);
  const href = url?.href ?? "";
  useEffect(() => {
    if (!url) return setLookup(null);
    setLookup({ url: href, loading: true, existing: null, suggested: null });
    let live = true;
    const timer = window.setTimeout(() => {
      void siteBookmarks(url).then((items) => {
        if (!live) return;
        const existing = items.find((b) => samePage(b.url, href)) ?? null;
        const suggestion = suggestFrom(items, draftBookmark(url));
        setLookup({ url: href, loading: false, existing, suggested: suggestion?.collection_id ?? null });
      });
    }, LOOKUP_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [href]);

  // The page itself and its feeds (NP-133): one request once the address settles, one more
  // to the feed only when «Follow» is turned on. Save reuses the answer: the app keeps it.
  const linkPreview = useLinkPreview(pasted !== null && pasted === text ? url : null);
  const [follow, setFollow] = useState(false);
  const [chosen, setChosen] = useState(0);
  const [feedDestination, setFeedDestination] = useState<FeedDestination>("feeds");
  /** Followed from this sheet: the line says so, as for a site followed before. */
  const [followedUid, setFollowedUid] = useState<string | null>(null);
  useEffect(() => {
    setFollow(false);
    setChosen(0);
    setFollowedUid(null);
  }, [href]);
  const bare = linkPreview.state === "done" && !!linkPreview.page?.is_feed;
  const asked = feedOffer(linkPreview, chosen, follow, { state: "idle" });
  const feedPreview = useFeedPreview(asked.kind === "offer" || asked.kind === "feed" ? asked.candidate : null, follow || bare);
  const offer: FeedOffer = followedUid
    ? { kind: "followed", uid: followedUid, site: asked.kind === "offer" ? asked.site : "" }
    : feedOffer(linkPreview, chosen, follow, feedPreview);
  const primary = primaryAction(offer);
  /** A bare feed is followed, not saved: no place, no collection, no title. */
  const feedOnly = primary === "follow";

  const known = lookup && !lookup.loading && lookup.url === href ? lookup : null;
  const existing = saved ?? known?.existing ?? null;
  const suggested = known?.suggested ?? null;
  const live = (id: number | null | undefined) => (id != null && collections.some((c) => c.id === id) ? id : null);
  const collection = picked !== undefined ? live(picked) : (live(initialCollection) ?? live(suggested));
  const inbox = destination === "inbox";

  const change = (value: string) => {
    if (pasting.current) {
      pasting.current = false;
      setPasted(value);
    }
    setText(value);
    setError("");
    setSaved(null);
  };
  const save = async (link = typedLink(text)) => {
    if (busy) return;
    if (!link) {
      field.current?.focus();
      return;
    }
    const candidate = offer.kind === "offer" || offer.kind === "feed" ? offer.candidate : null;
    const following = candidate && (primary === "saveFollow" || primary === "follow") ? candidate : null;
    const there = !!existing && samePage(existing.url, link);
    // Known to be there already: saving would change nothing, the sheet says so and offers it.
    if (there && !following) return;
    setBusy(true);
    setError("");
    try {
      // A bare feed: only the subscription, no bookmark (NP-133).
      if (feedOnly && following) {
        await subscribeFeed(following.url, null, feedDestination);
        onClose();
        return;
      }
      if (there && following) {
        setFollowedUid((await subscribeFeed(following.url, null, feedDestination)).uid);
        return;
      }
      const already = await onSave({
        url: link,
        title: title.trim() || undefined,
        collectionId: inbox ? null : collection,
        tags,
        destination,
      });
      // The bookmark first, then the subscription (plan §6.5). The sheet may be gone by now.
      if (following) setFollowedUid((await subscribeFeed(following.url, null, feedDestination)).uid);
      if (already) {
        setText(link);
        setSaved(already);
      }
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
  const draft = url && (existing ?? (page ? previewedBookmark(url, page.metadata) : draftBookmark(url)));
  const path = url && url.pathname !== "/" ? url.pathname : "";
  const chip = (pressed: boolean) => `add-chip ${pressed ? "is-on" : ""}`;
  const slot = error ? (
    <p role="alert" className="add-note is-error">
      {error}
    </p>
  ) : draft && (existing || known) ? (
    <div className="add-preview" data-add-preview={existing ? "existing" : "new"}>
      <span className="add-thumb">
        <Preview b={draft} small />
      </span>
      <span className="min-w-0 flex-1">
        <b className="block truncate text-[13px] font-semibold" data-user-text>
          {existing ? existing.title || existing.url : draft.title || siteName(draft)}
        </b>
        <span className="block truncate text-xs text-meta">
          {existing ? t("add.existing") : `${draft.domain}${path}`}
        </span>
      </span>
      {existing && (
        <button type="button" className="add-small-btn" onClick={() => onShow(existing)}>
          {t("add.show")}
        </button>
      )}
    </div>
  ) : draft ? (
    <div className="add-preview" data-add-preview="loading" aria-hidden>
      <span className="add-thumb add-shimmer" />
      <span className="grid flex-1 gap-[7px]">
        <span className="add-shimmer h-2.5 w-[70%] rounded-[5px]" />
        <span className="add-shimmer h-2.5 w-[40%] rounded-[5px]" />
      </span>
    </div>
  ) : !text.trim() && clip ? (
    <div className="add-clip">
      <Icon icon={ClipboardPaste} className="shrink-0 text-icon" />
      <span className="min-w-0 flex-1 truncate text-muted">
        {t("add.clipboard")} <b className="font-semibold text-ink">{clip.replace(/^https?:\/\/(www\.)?/, "")}</b>
      </span>
      <button
        type="button"
        className="add-ink-btn h-[26px] rounded-lg px-2.5 text-xs"
        onClick={() => {
          change(clip);
          setPasted(clip);
          field.current?.focus();
        }}
      >
        {t("add.clipboardAdd")}
      </button>
    </div>
  ) : (
    <p className={`add-note ${text.trim() ? "is-warn" : ""}`}>{text.trim() ? t("add.notLink") : t("add.hint")}</p>
  );

  const rate = offer.kind === "offer" || offer.kind === "feed" ? (offer.preview ? feedRate(offer.preview) : null) : null;
  const last =
    (offer.kind === "offer" || offer.kind === "feed") && offer.preview?.last_post_at ? relativeTime(offer.preview.last_post_at, i18n.language) : null;
  const numbers = [rate && t(rate.key, { count: rate.count }), last && t("add.feedLast", { when: last })].filter(Boolean).join(" · ");
  const feedLine =
    offer.kind === "offer" || offer.kind === "feed"
      ? offer.status === "unreadable"
        ? t("add.feedUnreadable")
        : offer.status === "looking"
          ? t("add.feedLooking")
          : offer.status === "ready"
            ? numbers || t("add.feedOffHint")
            : t("add.feedOffHint")
      : "";
  const feedRow =
    offer.kind === "none" ? null : (
      <div
        className="mt-2 grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 rounded-[14px] bg-well p-2.5"
        data-feed-offer={offer.kind === "followed" ? "followed" : offer.status}
      >
        <span aria-hidden className="grid size-9 place-items-center rounded-[10px] bg-accent-soft text-accent">
          <Icon icon={Rss} size={17} />
        </span>
        <span className="min-w-0">
          <b className="block truncate text-[13px] font-semibold" data-user-text>
            {offer.kind === "followed"
              ? t("add.feedFollowed")
              : offer.kind === "feed"
                ? t("add.feedFollowTitle", { title: offer.title })
                : t("add.feedHas", { site: offer.site })}
          </b>
          {offer.kind !== "followed" && (
            <span className={`block truncate text-xs ${offer.status === "unreadable" ? "text-amber" : "text-muted"}`}>{feedLine}</span>
          )}
        </span>
        <span className="flex items-center gap-2">
          {offer.kind === "offer" && offer.candidates.length > 1 && (
            // A native list: a menu of the app's own would open under the modal sheet.
            <select
              aria-label={t("add.feedChoose")}
              className="h-[26px] max-w-[140px] rounded-lg bg-transparent px-1.5 text-xs text-muted hover:bg-hover"
              value={offer.candidates.indexOf(offer.candidate)}
              onChange={(e) => setChosen(Number(e.target.value))}
            >
              {offer.candidates.map((c, i) => (
                <option key={c.url} value={i}>
                  {c.title || c.url}
                </option>
              ))}
            </select>
          )}
          {offer.kind === "offer" && (
            <Switch checked={follow} onChange={setFollow} label={t("add.feedToggle", { site: offer.candidate.title || offer.site })} />
          )}
          {offer.kind === "followed" && onShowFeed && (
            <button type="button" className="add-small-btn" onClick={() => onShowFeed(offer.uid)}>
              {t("add.feedShow")}
            </button>
          )}
        </span>
      </div>
    );
  // «New posts go to» while «Follow» is on, or for a bare feed that can be read.
  const feedPlaces = (primary === "saveFollow" || primary === "follow") && (
    <div role="group" aria-label={t("add.feedDestination")} className="flex flex-wrap items-center gap-1.5 px-1 pt-2.5">
      <span className="mr-0.5 text-xs text-subtle">{t("add.feedDestination")}</span>
      {(
        [
          ["feeds", t("add.feedDestFeeds")],
          ["inbox", t("add.feedDestInbox")],
          ["notify", t("add.feedDestNotify")],
        ] as const
      ).map(([value, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={feedDestination === value}
          className={chip(feedDestination === value)}
          onClick={() => setFeedDestination(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      data-add-sheet
      className="add-sheet"
      onCancel={(e) => {
        e.preventDefault();
        closeRef.current();
      }}
      onClick={(e) => {
        // The scrim around the sheet closes it, as Esc does.
        if (e.target === ref.current) closeRef.current();
      }}
    >
      {open && (
        <form className="add-sheet-body" onSubmit={submit} noValidate>
          <h2 id={titleId} className="sr-only">
            {t("add.title")}
          </h2>
          <label className="add-big">
            <Icon icon={Link} className="shrink-0 text-subtle" />
            <input
              ref={field}
              autoFocus
              aria-label={t("add.url")}
              placeholder={t("add.placeholder")}
              value={text}
              onPaste={() => {
                pasting.current = true;
              }}
              onChange={(e) => change(e.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              inputMode="url"
            />
            <kbd aria-hidden className="add-cap">
              {shortcut("V")}
            </kbd>
          </label>
          {!feedOnly && <div className="add-slot">{slot}</div>}
          {feedRow}
          {feedPlaces}
          {!feedOnly && (
            <>
              <div className="add-opts">
                <div role="group" aria-label={t("add.where")} className="contents">
                  {(
                    [
                      ["library", t("import.library")],
                      ["inbox", t("nav.inbox")],
                      ["reading", t("nav.reading")],
                    ] as const
                  ).map(([value, label]) => (
                    <button key={value} type="button" aria-pressed={destination === value} className={chip(destination === value)} onClick={() => setDestination(value)}>
                      {label}
                    </button>
                  ))}
                </div>
                {collections.length > 0 && <span aria-hidden className="add-opts-line" />}
                {collections.length > 0 && (
                  <div role="group" aria-label={t("editor.collection")} className="contents">
                    {collections.map((c) => {
                      const on = !inbox && collection === c.id;
                      return (
                        <button
                          key={c.id}
                          type="button"
                          aria-pressed={on}
                          disabled={inbox}
                          data-suggested={suggested === c.id || undefined}
                          title={suggested === c.id ? t("add.suggested") : undefined}
                          className={chip(on)}
                          // A second click on the chosen one leaves the link without a collection.
                          onClick={() => setPicked(on ? null : c.id)}
                        >
                          <Dot color={collectionColor(c.id)} className="size-[7px]" />
                          <span className="max-w-[160px] truncate" data-user-text>
                            {c.name}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <button type="button" className="add-more" aria-expanded={more} aria-controls={moreId} onClick={() => setMore(!more)}>
                <Icon icon={ChevronDown} size={13} className="add-more-chevron" />
                {t("add.more")}
              </button>
              {more && (
                <div id={moreId} className="grid grid-cols-2 gap-2 px-1 pt-1">
                  <input aria-label={t("add.name")} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`${t("add.name")} · ${t("add.optional")}`} className="field" />
                  <span>
                    <label htmlFor={`${moreId}-tags`} className="sr-only">
                      {t("editor.tags")}
                    </label>
                    <TagInput id={`${moreId}-tags`} tags={tags} onChange={setTags} />
                  </span>
                </div>
              )}
            </>
          )}
          <footer className="add-foot">
            <span className="add-keys" aria-hidden>
              <span>
                <kbd className="add-cap">↵</kbd>
                {t("add.keySave")}
              </span>
              <span>
                <kbd className="add-cap">Esc</kbd>
                {t("add.keyClose")}
              </span>
            </span>
            <button type="button" className="add-cancel" onClick={() => closeRef.current()}>
              {t("common.cancel")}
            </button>
            <button type="submit" className="add-ink-btn h-[34px] rounded-[10px] px-3.5 text-[13px]" disabled={busy}>
              {busy
                ? t(feedOnly ? "add.feedFollowing" : "add.saving")
                : t(primary === "follow" ? "add.feedFollow" : primary === "saveFollow" ? "add.feedSaveFollow" : "add.save")}
            </button>
          </footer>
        </form>
      )}
    </dialog>
  );
}
