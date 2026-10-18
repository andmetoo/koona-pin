import { ReactNode, useEffect, useRef, useState } from "react";
import { ChevronDown, CircleAlert, CircleArrowDown, CircleCheck, FileText, Info, RefreshCw, Rss } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Collection } from "../types";
import type { ListCheck } from "../bindings/ListCheck";
import type { ListImportReport } from "../bindings/ListImportReport";
import type { ListPreview } from "../bindings/ListPreview";
import { api } from "../services/api";
import { describeError } from "../services/errors";
import type { OpenRequest } from "../services/openRequests";
import {
  defaultChoices,
  Destination,
  downloadFailure,
  downloadShare,
  DownloadReason,
  fileOf,
  hostOf,
  footerAction,
  importOptions,
  ListChoices,
  nothingNew,
  otherAppName,
  Refusal,
  refusalOf,
} from "../services/lists";
import { Icon } from "./icons";
import { Footer, Scrolling } from "./library/Dialogs";
import { Button } from "./ui/Button";
import { Segmented, StatePanels, Switch } from "./ui/Controls";
import { Dialog } from "./ui/Dialog";

/** Where a list's text came from and what the dialog calls it. */
type Loaded = { text: string; preview: ListPreview };

type Phase =
  | { state: "reading" }
  | { state: "ask" }
  | { state: "downloading"; received: number; total: number | null }
  | { state: "failed"; key: DownloadReason; status?: number }
  | Refusal
  | { state: "preview"; error?: string }
  | { state: "importing"; done: number; total: number }
  | { state: "report"; report: ListImportReport }
  | { state: "nothing" };

const STATES = ["reading", "ask", "downloading", "failed", "newer", "otherApp", "notList", "preview", "importing", "report", "nothing"] as const;

/** New feeds shown before «Show N more feeds». */
const FEEDS_SHOWN = 4;

/**
 * The list dialog (NP-138, frames K1a, K1b and K3): every `.kpin` request ends here. A link first
 * asks and only then downloads; the preview writes nothing; the import is one transaction with
 * progress; the report or a refusal closes it. One dialog, 600 px wide and one height, 640 px or
 * the window less 48 px, the preview's middle scrolling. `onClose` runs on every way out.
 */
export function ListImportDialog({
  request,
  collections,
  onClose,
  onImported,
  onShowCollection,
  onCheckUpdates,
  onOpen,
  onBusy,
}: {
  request: OpenRequest;
  collections: Collection[];
  onClose: () => void;
  /** After a committed import: the library is read again. */
  onImported: () => Promise<void>;
  onShowCollection: (id: number) => void;
  onCheckUpdates: () => void;
  onOpen: (url: string) => void;
  /** Downloading or importing: App keeps the dialog, and a new request is refused meanwhile. */
  onBusy: (busy: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const url = request.kind === "kpin-url" ? request.url : null;
  const [phase, setPhase] = useState<Phase>(url ? { state: "ask" } : { state: "reading" });
  const [list, setList] = useState<Loaded | null>(null);
  const [choices, setChoices] = useState<ListChoices | null>(null);
  const [allFeeds, setAllFeeds] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);
  const number = (n: number) => n.toLocaleString(i18n.language);

  const show = (check: ListCheck, text: string) => {
    if (!alive.current) return;
    if (check.outcome !== "ready") return setPhase(refusalOf(check));
    setList({ text, preview: check.preview });
    setChoices(defaultChoices(check.preview));
    setPhase(nothingNew(check.preview) ? { state: "nothing" } : { state: "preview" });
  };
  const preview = (text: string, source: string) =>
    api.previewList(text, source).then(
      (check) => show(check, text),
      () => alive.current && setPhase({ state: "notList", reason: "unreadable" }),
    );

  // A dropped or picked file is read already; a file the system opened is read by Rust.
  useEffect(() => {
    if (request.kind === "kpin") void preview(request.text, request.name);
    else if (request.kind === "kpin-path")
      void api.readListFile(request.path).then(
        (file) => {
          if (!alive.current) return;
          if (file.outcome === "read") return void preview(file.text, file.name);
          setPhase({ state: "notList", reason: file.outcome });
        },
        () => alive.current && setPhase({ state: "notList", reason: "unreadable" }),
      );
    // The request is this dialog's for its whole life: App gives each one a dialog of its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** A download or an import under way: a second click starts nothing. */
  const inFlight = useRef(false);
  /** The number of the download the bar follows: a late event of an earlier one is ignored. */
  const ticket = useRef(0);
  const download = () => {
    if (!url || inFlight.current) return;
    inFlight.current = true;
    const mine = ++ticket.current;
    setPhase({ state: "downloading", received: 0, total: null });
    const off = api.onListDownloadProgress(
      (p) =>
        alive.current &&
        p.ticket === mine &&
        setPhase((now) => (now.state === "downloading" ? { state: "downloading", received: p.received, total: p.total } : now)),
    );
    void api
      .downloadList(url, mine)
      .then(
        (result) => {
          if (!alive.current || result.outcome === "cancelled") return;
          if (result.outcome === "done") return void preview(result.text, hostOf(result.url));
          if (result.outcome === "not_a_list") return setPhase({ state: "notList", reason: "not_a_list" });
          setPhase({ state: "failed", ...(downloadFailure(result) ?? { key: "unreachable" }) });
        },
        () => alive.current && setPhase({ state: "failed", key: "unreachable" }),
      )
      .finally(() => {
        off();
        inFlight.current = false;
      });
  };

  const importing = phase.state === "importing";
  useEffect(() => {
    if (!importing) return;
    return api.onImportProgress((p) => alive.current && setPhase((now) => (now.state === "importing" ? { state: "importing", done: p.done, total: p.total } : now)));
  }, [importing]);

  const busy = phase.state === "downloading" || importing;
  const onBusyRef = useRef(onBusy);
  onBusyRef.current = onBusy;
  useEffect(() => onBusyRef.current(busy), [busy]);
  // A dialog that goes while it downloads (another surface, the app) stops the download.
  const downloading = useRef(false);
  downloading.current = phase.state === "downloading";
  useEffect(
    () => () => {
      if (downloading.current) void api.cancelListDownload().catch(console.error);
      onBusyRef.current(false);
    },
    [],
  );

  /** Every way out but an import under way: Escape, «×», Cancel, Close, Done. */
  const close = () => {
    if (phase.state === "downloading") {
      downloading.current = false;
      void api.cancelListDownload().catch(console.error);
    }
    onClose();
  };
  const start = async () => {
    if (!list || !choices || inFlight.current) return;
    inFlight.current = true;
    setPhase({ state: "importing", done: 0, total: list.preview.new_links });
    try {
      const report = await api.importList(list.text, importOptions(list.preview, choices));
      await onImported().catch(console.error);
      if (alive.current) setPhase({ state: "report", report });
    } catch (err) {
      if (alive.current) setPhase({ state: "preview", error: describeError(err) });
    } finally {
      inFlight.current = false;
    }
  };

  const host = url ? hostOf(url) : "";

  /** A K3 state: a mark, a heading and its words, centred over the footer. */
  const message = (icon: typeof CircleAlert, tone: "accent" | "danger" | "muted", heading: string, text: ReactNode, footer: ReactNode, extra?: ReactNode) => (
    <>
      {/* In a low window the words scroll and the footer stays put. */}
      <div className="-m-1 flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto p-1 px-6 text-center before:flex-1 after:flex-1">
        <span
          className={`mb-2 flex size-11 items-center justify-center rounded-full ${tone === "accent" ? "bg-accent-soft text-accent" : tone === "danger" ? "bg-danger-soft text-on-danger-soft" : "bg-secondary text-icon"}`}
        >
          <Icon icon={icon} size={22} />
        </span>
        <p role="status" className="text-lg font-semibold text-balance [overflow-wrap:anywhere]">
          {heading}
        </p>
        <div className="max-w-[440px] text-sm text-muted [overflow-wrap:anywhere]">{text}</div>
        {extra}
      </div>
      <Footer>{footer}</Footer>
    </>
  );

  const bar = (share: number | null, label: string) => (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={share === null ? undefined : Math.round(share * 100)} className="mt-3 h-1 w-full max-w-[360px] overflow-hidden rounded-full bg-hover">
      <div className={`h-full rounded-full bg-accent transition-[width] duration-150 ${share === null ? "w-1/3 animate-pulse" : ""}`} style={share === null ? undefined : { width: `${share * 100}%` }} />
    </div>
  );

  const counts = (p: ListPreview) => {
    const first = [
      p.links > 0 && t("import.links", { count: p.links }),
      p.feeds > 0 && t("import.opmlFeeds", { count: p.feeds }),
      p.sections > 0 && t("lists.sections", { count: p.sections }),
    ].filter(Boolean);
    // Items of a type this version does not know are skipped in every version, not only a newer one.
    const skipped = p.not_web + p.invalid + p.skipped_items;
    const second = [
      p.already_saved > 0 && t("lists.alreadySaved", { count: p.already_saved }),
      p.in_trash > 0 && t("lists.inTrash", { count: p.in_trash }),
      p.feeds_followed > 0 && t("lists.feedsFollowed", { count: p.feeds_followed }),
      p.repeated > 0 && t("lists.repeated", { count: p.repeated }),
      skipped > 0 && t("lists.skipped", { count: skipped }),
    ].filter(Boolean);
    return (
      <div data-list-counts>
        <p className="text-sm font-medium">{first.join(" · ")}</p>
        {second.length > 0 && <p className="mt-0.5 text-xs text-muted">{second.join(" · ")}</p>}
      </div>
    );
  };

  /** A row of the preview: what it is, a line under it, its control on the right. */
  const row = (title: string, hint: string, control: ReactNode, below?: ReactNode) => (
    <div className="border-t border-divider pt-3.5">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-xs text-muted">{hint}</p>
        </div>
        {control}
      </div>
      {below}
    </div>
  );

  const destinationValue = (d: Destination) => (d.kind === "existing" ? String(d.id) : d.kind);

  const previewPanel = (error?: string) => {
    if (!list || !choices) return null;
    const p = list.preview;
    const set = (change: Partial<ListChoices>) => setChoices({ ...choices, ...change });
    const others = collections.filter((c) => c.id !== p.existing_collection?.id);
    const meta = [p.meta.author_name, p.meta.license, p.meta.updated && formatDay(p.meta.updated, i18n.language), p.source].filter(Boolean);
    const action = footerAction(p, choices);
    const what =
      action.kind === "import"
        ? [action.links > 0 && t("import.links", { count: action.links }), action.feeds > 0 && t("import.opmlFeeds", { count: action.feeds })].filter(Boolean).join(" · ")
        : "";
    const shownFeeds = allFeeds ? p.new_feeds : p.new_feeds.slice(0, FEEDS_SHOWN);
    return (
      <>
        <Scrolling>
          <div className="flex flex-col gap-1">
            <h3 className="text-xl leading-[26px] font-semibold tracking-[-0.012em] text-balance [overflow-wrap:anywhere]">{p.meta.title}</h3>
            {p.meta.description && <p className="line-clamp-3 text-sm text-muted [overflow-wrap:anywhere]">{p.meta.description}</p>}
            {meta.length > 0 && <p className="truncate text-xs text-subtle" title={meta.join(" · ")}>{meta.join(" · ")}</p>}
          </div>
          {counts(p)}
          {p.newer && (
            <div data-list-newer className="flex gap-2.5 rounded-xl bg-accent-soft p-3 text-xs">
              <Icon icon={Info} className="shrink-0 text-accent" />
              <div>
                <p className="font-medium text-ink">{t("lists.newer", { version: p.meta.version })}</p>
                {p.skipped_details + p.skipped_items > 0 && (
                  <p className="text-muted">
                    {p.skipped_details > 0 && p.skipped_items > 0
                      ? t("lists.newerText", { details: t("lists.details", { count: p.skipped_details }), items: t("lists.items", { count: p.skipped_items }) })
                      : t("lists.newerSome", {
                          what: p.skipped_details > 0 ? t("lists.details", { count: p.skipped_details }) : t("lists.items", { count: p.skipped_items }),
                        })}
                  </p>
                )}
              </div>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="list-destination" className="text-xs font-medium text-muted">
              {t("lists.putInto")}
            </label>
            <div className="relative">
              <select
                id="list-destination"
                value={destinationValue(choices.destination)}
                onChange={(e) => {
                  const v = e.target.value;
                  set({ destination: v === "list" ? { kind: "list" } : v === "none" ? { kind: "none" } : { kind: "existing", id: Number(v) } });
                }}
                className="field appearance-none pr-8"
              >
                <option value="list">
                  {p.existing_collection ? t("lists.collectionExists", { name: p.existing_collection.name }) : t("lists.collectionNew", { name: p.meta.title })}
                </option>
                {others.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
                <option value="none">{t("lists.noCollection")}</option>
              </select>
              <Icon icon={ChevronDown} size={14} className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-icon" />
            </div>
            <p className="text-xs text-subtle">{t("lists.reused")}</p>
          </div>
          <div className="flex flex-col gap-3.5">
            {row(t("lists.toInbox"), t("lists.toInboxHint"), <Switch label={t("lists.toInbox")} checked={choices.toInbox} onChange={(toInbox) => set({ toInbox })} />)}
            {/* Only links take tags: sections of feeds alone change nothing. */}
            {p.sectioned_links > 0 &&
              row(
                t("lists.sectionsTitle"),
                t("lists.sectionsHint"),
                <Segmented<"tags" | "ignore">
                  label={t("lists.sectionsTitle")}
                  value={choices.sectionsAsTags ? "tags" : "ignore"}
                  onChange={(v) => set({ sectionsAsTags: v === "tags" })}
                  options={[
                    { value: "tags", label: t("lists.asTags") },
                    { value: "ignore", label: t("lists.ignore") },
                  ]}
                />,
              )}
            {p.already_saved > 0 &&
              row(
                t("lists.existing"),
                t("lists.existingHint"),
                <Segmented<"leave" | "add_tags">
                  label={t("lists.existing")}
                  value={choices.existing}
                  onChange={(existing) => set({ existing })}
                  options={[
                    { value: "leave", label: t("lists.leave") },
                    { value: "add_tags", label: t("lists.addTags") },
                  ]}
                />,
              )}
            {p.new_feeds.length > 0 &&
              row(
                t("lists.follow", { count: p.new_feeds.length }),
                p.feeds_followed > 0 ? t("lists.followedHint", { count: p.feeds_followed }) : t("lists.followHint"),
                <Switch label={t("lists.follow", { count: p.new_feeds.length })} checked={choices.follow} onChange={(follow) => set({ follow })} />,
                choices.follow && (
                  <ul data-list-feeds className="mt-2.5 flex flex-col gap-0.5 rounded-xl bg-secondary p-1.5">
                    {shownFeeds.map((feed) => {
                      const checked = choices.feeds.includes(feed.url);
                      return (
                        <li key={feed.url}>
                          <label className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-hover">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => set({ feeds: checked ? choices.feeds.filter((u) => u !== feed.url) : [...choices.feeds, feed.url] })}
                              className="size-4 shrink-0 accent-accent"
                            />
                            <Icon icon={Rss} size={14} className="shrink-0 text-icon" />
                            <span className="min-w-0 flex-1 truncate" title={feed.url}>
                              {feed.title || hostOf(feed.url)}
                            </span>
                            {feed.section && <span className="max-w-[40%] shrink-0 truncate text-xs text-subtle">{feed.section}</span>}
                          </label>
                        </li>
                      );
                    })}
                    {!allFeeds && p.new_feeds.length > FEEDS_SHOWN && (
                      <li>
                        <button type="button" onClick={() => setAllFeeds(true)} className="px-2 py-1.5 text-xs font-medium text-accent hover:underline">
                          {t("lists.showMore", { count: p.new_feeds.length - FEEDS_SHOWN })}
                        </button>
                      </li>
                    )}
                  </ul>
                ),
              )}
          </div>
          {error && (
            <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2.5 text-sm text-on-danger-soft">
              {t("lists.failed", { reason: error })}
            </p>
          )}
        </Scrolling>
        <Footer>
          <p className="mr-auto self-center text-xs text-subtle">{t("lists.nothingSaved")}</p>
          <Button variant="outline" size="lg" onClick={close}>
            {t("import.cancel")}
          </Button>
          {action.kind === "close" ? (
            <Button variant="primary" size="lg" onClick={close}>
              {t("common.close")}
            </Button>
          ) : (
            <Button variant="primary" size="lg" onClick={() => void start()}>
              {action.kind === "tags" ? t("lists.tagOnly", { count: action.links }) : t("lists.import", { what })}
            </Button>
          )}
        </Footer>
      </>
    );
  };

  const reportPanel = (report: ListImportReport) => {
    const skipped = report.not_web + report.invalid + report.skipped_items;
    const lines = [
      [t("import.added"), report.added],
      report.already_saved > 0 && [t(choices?.existing === "add_tags" ? "lists.reportTagged" : "import.existing"), report.already_saved],
      report.in_trash > 0 && [t("import.inTrash"), report.in_trash],
      report.repeated > 0 && [t("lists.reportRepeated"), report.repeated],
      skipped > 0 && [t("lists.reportSkipped"), skipped],
      report.feeds_followed > 0 && [t("lists.reportFeeds"), report.feeds_followed],
      report.feeds_already > 0 && [t("import.opmlExisting"), report.feeds_already],
    ].filter((line): line is [string, number] => !!line);
    return message(
      CircleCheck,
      "accent",
      t("lists.imported"),
      <>
        <p>{report.added > 0 ? t(choices?.toInbox ? "import.addedInbox" : "import.addedLibrary", { count: report.added }) : t("import.nothingNew")}</p>
        {report.added > 0 && <p className="mt-0.5 text-xs">{t("import.fetching")}</p>}
      </>,
      <>
        {report.collection_id !== null && (
          <Button variant="outline" size="lg" onClick={() => onShowCollection(report.collection_id!)}>
            {t("lists.showCollection")}
          </Button>
        )}
        <Button variant="primary" size="lg" autoFocus onClick={close}>
          {t("import.done")}
        </Button>
      </>,
      <div data-list-report className="mt-3 w-full max-w-[400px] border-y border-divider text-left">
        {lines.map(([label, count]) => (
          <div key={label} className="flex items-center justify-between gap-3 border-t border-divider py-2 text-sm first:border-t-0">
            <span>{label}</span>
            <span className="font-medium tabular-nums">{number(count)}</span>
          </div>
        ))}
      </div>,
    );
  };

  const panel = (shown: Phase) => {
    const closeButton = (primary = true) => (
      <Button variant={primary ? "primary" : "outline"} size="lg" autoFocus={primary} onClick={close}>
        {t("common.close")}
      </Button>
    );
    switch (shown.state) {
      case "reading":
        return message(FileText, "muted", t("lists.reading"), null, <Button variant="outline" size="lg" onClick={close}>{t("import.cancel")}</Button>);
      case "ask":
        return message(
          CircleArrowDown,
          "accent",
          t("lists.ask", { host }),
          <>
            <p data-list-address className="rounded-lg bg-secondary px-3 py-2 font-mono text-xs break-all text-ink select-text">
              {url}
            </p>
            <p className="mt-2">{t("lists.askNote")}</p>
          </>,
          <>
            <Button variant="outline" size="lg" onClick={close}>
              {t("import.cancel")}
            </Button>
            <Button variant="primary" size="lg" autoFocus onClick={download}>
              {t("lists.download")}
            </Button>
          </>,
        );
      case "downloading": {
        const file = url ? fileOf(url) : "";
        return message(
          CircleArrowDown,
          "accent",
          t("lists.downloading"),
          <p>{[host, file].filter(Boolean).join(" · ")}</p>,
          <Button variant="outline" size="lg" autoFocus onClick={close}>
            {t("import.cancel")}
          </Button>,
          bar(downloadShare(shown.received, shown.total), t("lists.downloading")),
        );
      }
      case "failed":
        return message(
          CircleAlert,
          "danger",
          t("lists.downloadFailed"),
          <p>{t(`lists.reason_${shown.key}`, { status: shown.status })}</p>,
          <>
            {closeButton(false)}
            <Button variant="primary" size="lg" autoFocus onClick={download}>
              {t("common.retry")}
            </Button>
          </>,
        );
      case "newer":
        return message(
          RefreshCw,
          "accent",
          t("lists.needsNewer"),
          <p>{t("lists.needsNewerText")}</p>,
          <>
            {closeButton(false)}
            <Button
              variant="primary"
              size="lg"
              autoFocus
              onClick={() => {
                close();
                onCheckUpdates();
              }}
            >
              {t("lists.checkUpdates")}
            </Button>
          </>,
        );
      case "otherApp":
        return message(
          Info,
          "muted",
          t("lists.otherApp"),
          <p>{t("lists.otherAppText", { app: otherAppName(shown.app) })}</p>,
          <>
            {closeButton(false)}
            <Button variant="primary" size="lg" autoFocus onClick={() => onOpen("https://koona.app")}>
              {t("lists.getIt")}
            </Button>
          </>,
        );
      case "notList":
        return message(CircleAlert, "danger", t("lists.notList"), <p>{t(`lists.notList_${shown.reason}`)}</p>, closeButton());
      case "preview":
        return previewPanel(shown.error);
      case "importing": {
        const total = Math.max(shown.total, 1);
        return message(
          FileText,
          "accent",
          t("lists.importing"),
          <p>{t("import.progress", { done: shown.done, count: shown.total })}</p>,
          null,
          bar(shown.total ? Math.min(1, shown.done / total) : null, t("lists.importing")),
        );
      }
      case "report":
        return reportPanel(shown.report);
      case "nothing": {
        const p = list?.preview;
        return message(
          CircleCheck,
          "muted",
          t("lists.nothingNew"),
          p && (
            <>
              <p>{t("lists.nothingNewText", { name: p.meta.title })}</p>
              <div className="mt-2">{counts(p)}</div>
            </>
          ),
          closeButton(),
        );
      }
    }
  };

  return (
    <Dialog title={t("lists.title")} eyebrow width={600} height="min(640px, calc(100vh - 48px))" onClose={close} locked={importing}>
      {/* The states share the dialog's one height (NP-118): no unseen copies are needed to size it. */}
      <div data-list-dialog={phase.state} className="flex min-h-0 flex-1 flex-col *:flex-1">
        <StatePanels value={phase.state} states={STATES}>
          {(state, sizing) => (sizing || state !== phase.state ? null : panel(phase))}
        </StatePanels>
      </div>
    </Dialog>
  );
}

/** `YYYY-MM-DD` of the list as a date of the interface's language, or as written when it is not one. */
function formatDay(day: string, language: string) {
  const at = new Date(`${day}T00:00:00`);
  return Number.isNaN(at.getTime()) ? day : at.toLocaleDateString(language, { day: "numeric", month: "long", year: "numeric" });
}
