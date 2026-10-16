import { FormEvent, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ClipboardPaste, Link } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Bookmark, Collection } from "../../types";
import { api } from "../../services/api";
import { describeError } from "../../services/errors";
import { shortcut } from "../../services/keys";
import { collectionColor } from "../../services/collections";
import { siteName } from "../../services/cover";
import { suggestFrom } from "../../services/triage";
import { Destination, domainOf, draftBookmark, linkFrom, samePage, typedLink, webLink } from "../../services/addLink";
import { Icon } from "../icons";
import { Dot } from "../ui/Controls";
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
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const moreId = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
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

  const known = lookup && !lookup.loading && lookup.url === href ? lookup : null;
  const existing = saved ?? known?.existing ?? null;
  const suggested = known?.suggested ?? null;
  const live = (id: number | null | undefined) => (id != null && collections.some((c) => c.id === id) ? id : null);
  const collection = picked !== undefined ? live(picked) : (live(initialCollection) ?? live(suggested));
  const inbox = destination === "inbox";

  const change = (value: string) => {
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
    // Known to be there already: saving would change nothing, the sheet says so and offers it.
    if (existing && samePage(existing.url, link)) return;
    setBusy(true);
    setError("");
    try {
      const already = await onSave({
        url: link,
        title: title.trim() || undefined,
        collectionId: inbox ? null : collection,
        tags,
        destination,
      });
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

  const draft = url && (existing ?? draftBookmark(url));
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
        <b className="block truncate text-[13px] font-semibold">{existing ? existing.title || existing.url : siteName(draft)}</b>
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
          field.current?.focus();
        }}
      >
        {t("add.clipboardAdd")}
      </button>
    </div>
  ) : (
    <p className={`add-note ${text.trim() ? "is-warn" : ""}`}>{text.trim() ? t("add.notLink") : t("add.hint")}</p>
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
          <div className="add-slot">{slot}</div>
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
              {busy ? t("add.saving") : t("add.save")}
            </button>
          </footer>
        </form>
      )}
    </dialog>
  );
}
