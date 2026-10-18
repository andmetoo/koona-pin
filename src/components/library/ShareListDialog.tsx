import { ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FileText, KeyRound, Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Collection, Feed } from "../../types";
import type { ListLicense } from "../../bindings/ListLicense";
import type { ListSections } from "../../bindings/ListSections";
import { collectionColor } from "../../services/collections";
import { describeError } from "../../services/errors";
import { feedName } from "../../services/feeds";
import { savePreference, storedValue } from "../../services/preferences";
import {
  DraftItem,
  ListBuildOptions,
  ListDraft,
  ListSource,
  draftProblem,
  fileName,
  hostOf,
  itemHoldsKey,
  listMarkdown,
  lists,
  readDraft,
  slugify,
  today,
} from "../../services/shareList";
import { Icon } from "../icons";
import { Button } from "../ui/Button";
import { Dot, Field, Segmented } from "../ui/Controls";
import { Dialog } from "../ui/Dialog";
import { Menu, MenuEntry } from "../ui/Menu";

/** What the dialog's notice says after a save: the app's own notice, with «Show». */
export type ShareNotice = { text: string; alert: boolean; long?: boolean; show?: () => void };

/** Rows of a section in the preview before «…and N more». */
const PREVIEW_ROWS = 4;
/** The form changes as the person types: the list is built again after a pause. */
const BUILD_DELAY = 150;

const AUTHOR_NAME = "share.authorName";
const AUTHOR_URL = "share.authorUrl";

const sameSource = (a: ListSource, b: ListSource) =>
  a.kind === b.kind && (a.kind !== "collection" || b.kind !== "collection" || a.id === b.id);

function Check({ checked, onChange, label, hint }: { checked: boolean; onChange: (value: boolean) => void; label: string; hint?: string }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-4 shrink-0 accent-accent" />
        <label htmlFor={id} className="text-sm">
          {label}
        </label>
      </div>
      {hint && <p className="pl-6 text-xs text-subtle">{hint}</p>}
    </div>
  );
}

/** A label over a control that is not a single input: a group of chips, checkboxes, segments. */
function Group({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-1.5">
      <span id={id} className="text-xs font-medium text-muted">
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * «Share as list…» (NP-140, NP-141, frame K2): what goes in, the list's words and choices on the
 * left, the live preview of the file on the right. Save writes exactly the previewed text; Copy
 * as Markdown copies the same list for a post. The dialog has one size: 720 px wide, 640 px
 * high or the window height less 48 px, each column scrolling.
 */
export function ShareListDialog({
  start,
  collections,
  feeds,
  onClose,
  onNotice,
}: {
  /** Where it was opened: a collection, a selection, a feed or all feeds. */
  start: ListSource[];
  collections: Collection[];
  feeds: Feed[] | null;
  onClose: () => void;
  onNotice: (notice: ShareNotice) => void;
}) {
  const { t, i18n } = useTranslation();
  const [sources, setSources] = useState<ListSource[]>(start);
  const first = start[0];
  const [title, setTitle] = useState(() => (first?.kind === "collection" ? (collections.find((c) => c.id === first.id)?.name ?? "") : ""));
  const [description, setDescription] = useState("");
  const [authorName, setAuthorName] = useState(() => storedValue(AUTHOR_NAME) ?? "");
  const [authorUrl, setAuthorUrl] = useState(() => storedValue(AUTHOR_URL) ?? "");
  const [license, setLicense] = useState<ListLicense>("cc0");
  const [titles, setTitles] = useState(true);
  const [tags, setTags] = useState(true);
  const [notes, setNotes] = useState(false);
  const [sections, setSections] = useState<ListSections>("none");
  const [details, setDetails] = useState(false);
  const [id, setId] = useState<string | null>(null);
  const [language, setLanguage] = useState(i18n.language);
  const [updated, setUpdated] = useState(today);
  const [adding, setAdding] = useState<{ anchor: DOMRect; trigger: HTMLElement } | null>(null);
  /** The last text built, with the choices it was built for. */
  const [built, setBuilt] = useState<{ key: string; text: string } | null>(null);
  /** The last build failed: what is shown is not what would be saved. */
  const [buildError, setBuildError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const detailsId = useId();
  const listId = id ?? slugify(title);

  const options: ListBuildOptions = {
    sources,
    title,
    description,
    author_name: authorName,
    author_url: authorUrl,
    license,
    titles,
    tags,
    notes,
    sections,
    feeds_section: t("shareList.feedsSection"),
    links_word: t("shareList.linksWord"),
    id: listId,
    language,
    updated,
  };
  const key = JSON.stringify(options);
  const runs = useRef(0);
  useEffect(() => {
    const run = ++runs.current;
    const timer = window.setTimeout(() => {
      lists.buildList(JSON.parse(key) as ListBuildOptions).then(
        (next) => {
          if (run !== runs.current) return;
          setBuilt({ key, text: next });
          setBuildError("");
        },
        (err) => run === runs.current && setBuildError(describeError(err)),
      );
    }, BUILD_DELAY);
    return () => window.clearTimeout(timer);
  }, [key]);
  const text = built?.text ?? null;
  // Save and Copy take only the text built for the choices on screen: a click right after a
  // change waits for its build, and a failed build is never saved.
  const fresh = !!built && built.key === key && !buildError;
  const draft: ListDraft | null = useMemo(() => (text ? readDraft(text) : null), [text]);
  const problem = draft ? draftProblem(draft) : "empty";
  const keyed = draft ? draft.groups.flatMap((g) => g.items).filter(itemHoldsKey).length : 0;

  const remember = (name: string, value: string) => savePreference(name, value);
  const authorUrlWrong = !!authorUrl.trim() && !/^https?:\/\/[^/?#\s]+/i.test(authorUrl.trim());

  const save = async () => {
    if (!text || problem || !fresh) return;
    setBusy(true);
    setError("");
    try {
      const result = await lists.saveList(text, listId);
      if (result.outcome === "cancelled") return;
      if (result.outcome === "saved") {
        onNotice({
          text: t("shareList.saved", { name: result.file_name }),
          alert: false,
          long: true,
          show: () => void lists.reveal().catch((err) => onNotice({ text: describeError(err), alert: true })),
        });
        onClose();
        return;
      }
      const { file_name: name, folder, detail } = result;
      setError(
        result.problem === "disk_full"
          ? t("export.diskFull", { name })
          : result.problem === "no_permission"
            ? t("export.noPermission", { folder })
            : result.problem === "in_use"
              ? t("export.inUse", { name })
              : t("export.other", { name, detail }),
      );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const copyMarkdown = async () => {
    if (!draft || !fresh || problem === "title" || problem === "empty") return;
    try {
      await navigator.clipboard.writeText(listMarkdown(draft, t("shareList.feedWord")));
      setError("");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(t("notice.copyFailed"));
    }
  };

  const allFeeds = sources.some((s) => s.kind === "feeds" && !s.uids);
  const chipLabel = (source: ListSource) => {
    if (source.kind === "collection") {
      const collection = collections.find((c) => c.id === source.id);
      return t("shareList.chipCollection", { name: collection?.name ?? "", count: collection?.count ?? 0 });
    }
    if (source.kind === "bookmarks") return t("shareList.chipSelection", { count: source.ids.length });
    if (!source.uids) return t("shareList.chipFeeds", { count: feeds?.length ?? 0 });
    const only = source.uids.length === 1 ? feeds?.find((f) => f.uid === source.uids![0]) : undefined;
    return only ? t("shareList.chipFeed", { name: feedName(only) }) : t("shareList.chipFeeds", { count: source.uids.length });
  };
  const chipDot = (source: ListSource) => (source.kind === "collection" ? <Dot color={collectionColor(source.id)} /> : null);
  const addEntries: MenuEntry[] = [
    ...(collections.some((c) => !sources.some((s) => sameSource(s, { kind: "collection", id: c.id })))
      ? [{ heading: t("shareList.addCollections") }]
      : []),
    ...collections
      .filter((c) => !sources.some((s) => sameSource(s, { kind: "collection", id: c.id })))
      .map((c) => ({
        id: `collection-${c.id}`,
        label: c.name,
        dot: collectionColor(c.id),
        count: c.count ?? 0,
        onSelect: () => setSources((list) => [...list, { kind: "collection", id: c.id }]),
      })),
    ...(feeds?.length && !allFeeds
      ? [
          "separator" as const,
          {
            id: "feeds",
            label: t("shareList.addFeeds"),
            count: feeds.length,
            // All feeds take the place of some of them.
            onSelect: () => setSources((list) => [...list.filter((s) => s.kind !== "feeds"), { kind: "feeds", uids: null }]),
          },
        ]
      : []),
  ];

  const stats = draft
    ? [
        t("shareList.statsLinks", { count: draft.links }),
        t("shareList.statsFeeds", { count: draft.feeds }),
        draft.sections > 0 && t("shareList.statsSections", { count: draft.sections }),
        new Intl.NumberFormat(i18n.language, {
          style: "unit",
          unit: "kilobyte",
          maximumFractionDigits: draft.bytes < 10 * 1024 ? 1 : 0,
        }).format(Math.max(draft.bytes / 1024, 0.1)),
      ]
        .filter(Boolean)
        .join(" · ")
    : " ";
  // A row shows what the file will hold for the item: its title, the site, the description
  // (or the note in its place) and the tags, a line each.
  const row = (item: DraftItem, index: number) => (
    <li key={index} data-share-row className="flex min-w-0 flex-col py-1">
      <span className="flex min-w-0 items-center gap-2 text-sm">
        <span className="min-w-0 flex-1 truncate" title={item.url}>
          {item.title || hostOf(item.url)}
        </span>
        {item.type === "feed" && (
          <span className="shrink-0 rounded-sm bg-secondary px-1.5 py-px text-2xs font-medium text-muted">{t("shareList.feedBadge")}</span>
        )}
      </span>
      <span className="truncate text-xs text-subtle">{hostOf(item.url)}</span>
      {item.type === "link" && item.description && (
        <span data-share-description className="truncate text-xs text-muted">
          {item.description}
        </span>
      )}
      {item.type === "link" && item.tags?.length ? (
        <span data-share-tags className="truncate text-xs text-subtle">
          {item.tags.map((tag) => `#${tag}`).join(" ")}
        </span>
      ) : null}
      {itemHoldsKey(item) && (
        <span data-share-key className="flex items-center gap-1 text-xs text-danger">
          <Icon icon={KeyRound} size={12} className="shrink-0" />
          {t("shareList.mayHoldKey")}
        </span>
      )}
    </li>
  );
  const note =
    error ||
    buildError ||
    (problem === "too_big" ? t("shareList.tooBig") : problem === "empty" && draft ? t("shareList.empty") : t("shareList.holdsOnly"));
  const alarming = !!error || !!buildError || problem === "too_big" || (problem === "empty" && !!draft);

  return (
    <Dialog
      title={t("shareList.title")}
      caption={t("shareList.caption")}
      onClose={onClose}
      width={720}
      height="min(640px, calc(100vh - 48px))"
    >
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_260px] gap-5">
        <div data-share-form className="-m-1 flex min-h-0 flex-col gap-3 overflow-y-auto p-1">
          <Group label={t("shareList.whatGoesIn")}>
            <div className="flex flex-wrap items-center gap-1.5">
              {sources.map((source, index) => {
                const label = chipLabel(source);
                return (
                  <span key={index} data-share-chip className="flex h-7 max-w-full items-center gap-1.5 rounded-md bg-secondary pr-1 pl-2.5 text-xs">
                    {chipDot(source)}
                    <span className="truncate">{label}</span>
                    <button
                      type="button"
                      aria-label={t("shareList.remove", { name: label })}
                      title={t("shareList.remove", { name: label })}
                      onClick={() => setSources((list) => list.filter((_, i) => i !== index))}
                      className="flex size-5 shrink-0 items-center justify-center rounded-xs text-subtle hover:bg-hover hover:text-ink"
                    >
                      <Icon icon={X} size={12} />
                    </button>
                  </span>
                );
              })}
              {addEntries.length > 0 && (
                <button
                  type="button"
                  aria-haspopup="menu"
                  onClick={(e) => setAdding({ anchor: e.currentTarget.getBoundingClientRect(), trigger: e.currentTarget })}
                  className="flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-accent hover:bg-hover"
                >
                  <Icon icon={Plus} size={14} />
                  {t("shareList.add")}
                </button>
              )}
            </div>
          </Group>
          <Field label={t("shareList.titleLabel")}>
            {(fieldId) => (
              <input
                id={fieldId}
                autoFocus
                required
                maxLength={120}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("shareList.titlePlaceholder")}
                className="field"
              />
            )}
          </Field>
          <Field label={t("shareList.description")}>
            {(fieldId) => (
              <textarea
                id={fieldId}
                rows={2}
                maxLength={2000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="field resize-none"
              />
            )}
          </Field>
          <Group label={t("shareList.author")}>
            <div className="grid grid-cols-2 gap-2">
              <input
                aria-label={t("shareList.authorName")}
                value={authorName}
                maxLength={120}
                onChange={(e) => {
                  setAuthorName(e.target.value);
                  remember(AUTHOR_NAME, e.target.value);
                }}
                placeholder={t("shareList.authorName")}
                className="field"
              />
              <input
                aria-label={t("shareList.authorLink")}
                aria-invalid={authorUrlWrong || undefined}
                type="url"
                value={authorUrl}
                onChange={(e) => {
                  setAuthorUrl(e.target.value);
                  remember(AUTHOR_URL, e.target.value);
                }}
                placeholder={t("shareList.authorLinkPlaceholder")}
                className={`field ${authorUrlWrong ? "border-danger" : ""}`}
              />
            </div>
            <p className={`text-xs ${authorUrlWrong ? "text-danger" : "text-subtle"}`}>
              {authorUrlWrong ? t("shareList.authorLinkWrong") : t("shareList.authorHint")}
            </p>
          </Group>
          <Group label={t("shareList.license")}>
            <div className="flex">
              <Segmented<ListLicense>
                label={t("shareList.license")}
                value={license}
                onChange={setLicense}
                options={[
                  { value: "cc0", label: "CC0" },
                  { value: "cc_by", label: "CC BY 4.0" },
                  { value: "none", label: t("shareList.licenseNone") },
                ]}
              />
            </div>
          </Group>
          <Group label={t("shareList.include")}>
            <Check checked={titles} onChange={setTitles} label={t("shareList.includeTitles")} />
            <Check
              checked={tags}
              onChange={(on) => {
                setTags(on);
                // Sections by tag would show the tags kept out: they go with them.
                if (!on && sections === "by_tag") setSections("none");
              }}
              label={t("shareList.includeTags")}
            />
            <Check checked={notes} onChange={setNotes} label={t("shareList.includeNotes")} hint={t("shareList.notesHint")} />
          </Group>
          <Group label={t("shareList.sections")}>
            <div className="flex">
              <Segmented<ListSections>
                label={t("shareList.sections")}
                value={sections}
                onChange={setSections}
                // «By tag» needs the tags shared: with «Tags» off it is not offered.
                options={[
                  { value: "none" as const, label: t("shareList.sectionsNone") },
                  ...(tags ? [{ value: "by_tag" as const, label: t("shareList.sectionsByTag") }] : []),
                  { value: "by_collection" as const, label: t("shareList.sectionsByCollection") },
                ]}
              />
            </div>
          </Group>
          <div className="flex flex-col gap-3">
            <button
              type="button"
              aria-expanded={details}
              aria-controls={detailsId}
              onClick={() => setDetails(!details)}
              className="flex items-center gap-1 self-start text-sm font-medium text-accent hover:underline"
            >
              <Icon icon={details ? ChevronDown : ChevronRight} size={14} />
              {t("shareList.details")}
            </button>
            {details && (
              <div id={detailsId} className="flex flex-col gap-3">
                <Field label={t("shareList.id")} hint={t("shareList.idHint")}>
                  {(fieldId, note) => (
                    <input
                      id={fieldId}
                      aria-describedby={note}
                      value={listId}
                      maxLength={64}
                      onChange={(e) => setId(e.target.value)}
                      placeholder="list"
                      className="field"
                    />
                  )}
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label={t("shareList.language")}>
                    {(fieldId) => <input id={fieldId} value={language} maxLength={35} onChange={(e) => setLanguage(e.target.value)} className="field" />}
                  </Field>
                  <Field label={t("shareList.updated")}>
                    {(fieldId) => <input id={fieldId} type="date" value={updated} onChange={(e) => setUpdated(e.target.value)} className="field" />}
                  </Field>
                </div>
              </div>
            )}
          </div>
        </div>

        <section
          aria-label={t("shareList.preview")}
          data-share-preview
          className="flex min-h-0 flex-col gap-2 overflow-y-auto rounded-xl bg-panel p-3"
        >
          <span className="text-2xs font-semibold tracking-wide text-subtle uppercase">{t("shareList.preview")}</span>
          <p className={`text-md font-semibold [overflow-wrap:anywhere] ${draft?.title ? "" : "text-faint"}`}>
            {draft?.title || t("shareList.untitled")}
          </p>
          <p data-share-stats className="text-xs text-muted">
            {stats}
          </p>
          <p className="flex items-center gap-1.5 text-xs text-subtle">
            <Icon icon={FileText} size={14} className="shrink-0" />
            <span className="truncate">{fileName(listId)}</span>
          </p>
          <div className="flex flex-col gap-2 border-t border-divider pt-2">
            {draft?.groups.map((group, index) => (
              <div key={index} className="flex flex-col">
                {group.name !== null && <h3 className="pt-1 text-xs font-semibold text-muted">{group.name}</h3>}
                <ul className="flex flex-col">
                  {group.items.slice(0, PREVIEW_ROWS).map(row)}
                  {group.items.length > PREVIEW_ROWS && (
                    <li className="py-1 text-xs text-subtle">{t("shareList.more", { count: group.items.length - PREVIEW_ROWS })}</li>
                  )}
                </ul>
              </div>
            ))}
          </div>
        </section>
      </div>
      {keyed > 0 && (
        <p data-share-keys className="mt-3 flex items-center gap-1.5 text-xs text-danger">
          <Icon icon={KeyRound} size={14} className="shrink-0" />
          {t("shareList.keysNotice", { count: keyed })}
        </p>
      )}
      <footer className="mt-4 flex items-center gap-2">
        <p
          role={alarming ? "alert" : undefined}
          className={`min-w-0 flex-1 text-xs [overflow-wrap:anywhere] ${alarming ? "text-danger" : "text-subtle"}`}
        >
          {note}
        </p>
        <Button variant="outline" size="lg" onClick={onClose}>
          {t("shareList.cancel")}
        </Button>
        <Button variant="outline" size="lg" disabled={!draft || !fresh || problem === "title" || problem === "empty"} onClick={() => void copyMarkdown()}>
          <span aria-live="polite">{copied ? t("shareList.copied") : t("shareList.copyMarkdown")}</span>
        </Button>
        <Button variant="primary" size="lg" disabled={!!problem || !fresh || busy} onClick={() => void save()}>
          {t("shareList.save")}
        </Button>
      </footer>
      {adding && (
        <Menu
          entries={addEntries}
          anchor={adding.anchor}
          align="start"
          label={t("shareList.add")}
          trigger={adding.trigger}
          onClose={() => setAdding(null)}
        />
      )}
    </Dialog>
  );
}
