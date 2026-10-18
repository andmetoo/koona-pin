import { ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, CircleAlert, CircleArrowDown, CircleCheck, FileText, Info, Link2, RefreshCw, Rss, Tag, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Collection } from "../types";
import type { ListCheck } from "../bindings/ListCheck";
import type { ListImportReport } from "../bindings/ListImportReport";
import type { ListPreview } from "../bindings/ListPreview";
import type { ListPreviewItem } from "../bindings/ListPreviewItem";
import { api } from "../services/api";
import { hash, monogram, PALETTE } from "../services/cover";
import { describeError } from "../services/errors";
import type { OpenRequest } from "../services/openRequests";
import { localPictureSrc } from "../services/pictures";
import {
  defaultChoices,
  Destination,
  downloadFailure,
  downloadShare,
  DownloadReason,
  fileOf,
  groupChoice,
  hostOf,
  importCounts,
  importOptions,
  ListChoices,
  nothingNew,
  otherAppName,
  PreviewRow,
  previewRows,
  Refusal,
  refusalOf,
  toggleGroup,
  toggleLink,
} from "../services/lists";
import { Icon } from "./icons";
import { Footer } from "./library/Dialogs";
import { Button } from "./ui/Button";
import { StatePanels } from "./ui/Controls";
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
  | { state: "report"; report: ListImportReport };

const STATES = ["reading", "ask", "downloading", "failed", "newer", "otherApp", "notList", "preview", "importing", "report"] as const;

/** The heights of the preview's rows (K10); the MINOR notice is measured. */
const ROW_HEIGHT = 32;
const GROUP_HEIGHT = 36;
const NOTICE_HEIGHT = 64;

/**
 * The list dialog (NP-138, frames K10a, K10b and K3): every `.kpin` request ends here. A link first
 * asks and only then downloads; the preview writes nothing; the import is one transaction with
 * progress; the report or a refusal closes it. One dialog, 600 px wide and one height, 640 px or
 * the window less 48 px; in the preview only the rows scroll, between the header and the choices.
 * `onClose` runs on every way out.
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
  /** Folded groups the person opened with «Show N more». */
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const rows = useMemo(() => (list ? previewRows(list.preview, open) : []), [list, open]);
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
    setPhase({ state: "preview" });
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
    setPhase({ state: "downloading", received: 0, total: null });
    const failed = () => alive.current && setPhase({ state: "failed", key: "unreachable" });
    // The ticket comes from Rust: tickets only grow while the app runs, so a Cancel sent before the
    // download started is still known to be this download's (download.rs).
    void api
      .nextListTicket()
      .then((mine) => {
        ticket.current = mine;
        // Closed while the ticket came: nothing is downloaded.
        if (!alive.current) return;
        const off = api.onListDownloadProgress(
          (p) =>
            alive.current &&
            p.ticket === mine &&
            setPhase((now) => (now.state === "downloading" ? { state: "downloading", received: p.received, total: p.total } : now)),
        );
        return api
          .downloadList(url, mine)
          .then(
            (result) => {
              if (!alive.current || result.outcome === "cancelled") return;
              if (result.outcome === "done") return void preview(result.text, hostOf(result.url));
              if (result.outcome === "not_a_list") return setPhase({ state: "notList", reason: "not_a_list" });
              setPhase({ state: "failed", ...(downloadFailure(result) ?? { key: "unreachable" }) });
            },
            failed,
          )
          .finally(off);
      }, failed)
      .finally(() => {
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
      if (downloading.current) void api.cancelListDownload(ticket.current).catch(console.error);
      onBusyRef.current(false);
    },
    [],
  );

  /** Every way out but an import under way: Escape, «×», Cancel, Close, Done. */
  const close = () => {
    if (phase.state === "downloading") {
      downloading.current = false;
      void api.cancelListDownload(ticket.current).catch(console.error);
    }
    onClose();
  };
  const start = async () => {
    if (!list || !choices || inFlight.current) return;
    inFlight.current = true;
    setPhase({ state: "importing", done: 0, total: list.preview.links });
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

  /** One 12 px line: what the list holds, then what it is to this library (K10). */
  const counts = (p: ListPreview) => {
    const holds = [
      p.links > 0 && t("import.links", { count: p.links }),
      p.feeds > 0 && t("import.opmlFeeds", { count: p.feeds }),
      p.sections > 0 && t("lists.sections", { count: p.sections }),
    ].filter(Boolean);
    // Items of a type this version does not know are skipped in every version, not only a newer one.
    const skipped = p.not_web + p.invalid + p.skipped_items;
    const here = [
      p.links > 0 && t("lists.countNew", { count: p.new_links }),
      p.already_saved > 0 && t("lists.countSaved", { count: p.already_saved }),
      p.in_trash > 0 && t("lists.inTrash", { count: p.in_trash }),
      p.repeated > 0 && t("lists.repeated", { count: p.repeated }),
      skipped > 0 && t("lists.skipped", { count: skipped }),
    ].filter(Boolean);
    const line = holds.join(" · ") + (here.length > 0 ? ` — ${here.join(", ")}` : "");
    return (
      <p data-list-counts className="truncate text-xs text-muted" title={line}>
        {line}
      </p>
    );
  };

  const destinationValue = (d: Destination) => (d.kind === "existing" ? String(d.id) : d.kind);

  const previewPanel = (error?: string) => {
    if (!list || !choices) return null;
    const p = list.preview;
    const set = (change: Partial<ListChoices>) => setChoices({ ...choices, ...change });
    const others = collections.filter((c) => c.id !== p.existing_collection?.id);
    const meta = [p.meta.author_name && t("lists.by", { name: p.meta.author_name }), p.meta.updated && formatDay(p.meta.updated, i18n.language), p.source].filter(Boolean);
    const nothing = nothingNew(p);
    const { links, feeds } = importCounts(p, choices);
    const adding =
      links > 0 && feeds > 0
        ? t("lists.andFeeds", { links: t("import.links", { count: links }), feeds: t("import.opmlFeeds", { count: feeds }) })
        : links > 0
          ? t("import.links", { count: links })
          : feeds > 0
            ? t("import.opmlFeeds", { count: feeds })
            : "";
    return (
      <div data-list-preview className="flex min-h-0 flex-1 flex-col">
        <div data-list-head className="flex shrink-0 flex-col gap-0.5 border-b border-divider pb-2">
          <h3 className="truncate text-xl leading-[26px] font-semibold tracking-[-0.012em]" title={p.meta.title}>
            {p.meta.title}
          </h3>
          {meta.length > 0 && (
            <p className="truncate text-xs text-muted" title={meta.join(" · ")}>
              {meta.join(" · ")}
            </p>
          )}
          {p.meta.description && <Description text={p.meta.description} />}
          {counts(p)}
        </div>
        <Rows
          preview={p}
          rows={rows}
          choices={choices}
          tags={choices.destination.kind !== "bare"}
          onChoose={set}
          onOpen={(group) => setOpen(new Set([...open, group]))}
        />
        {error && (
          <p role="alert" className="mt-2.5 shrink-0 rounded-xl bg-danger-soft px-3 py-2.5 text-sm text-on-danger-soft">
            {t("lists.failed", { reason: error })}
          </p>
        )}
        {!nothing && (
          <div data-list-choices className="flex shrink-0 flex-col gap-2.5 border-t border-divider pt-2.5">
            <div className="field relative flex items-center gap-2 p-0 pl-[11px] has-[select:focus-visible]:border-accent has-[select:focus-visible]:shadow-[inset_0_0_0_0.5px_var(--np-accent),0_0_0_3px_color-mix(in_srgb,var(--np-accent)_25%,transparent)]">
              <label htmlFor="list-destination" className="shrink-0 text-muted">
                {t("lists.putInto")}
              </label>
              <select
                id="list-destination"
                value={destinationValue(choices.destination)}
                onChange={(e) => {
                  const v = e.target.value;
                  set({
                    destination: v === "list" || v === "none" || v === "bare" ? { kind: v } : { kind: "existing", id: Number(v) },
                  });
                }}
                className="min-w-0 flex-1 appearance-none truncate bg-transparent py-[7px] pr-8 outline-none"
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
                <option value="bare">{t("lists.noSectionTags")}</option>
              </select>
              <Icon icon={ChevronDown} size={14} className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-icon" />
            </div>
            <label className="flex items-center gap-2 self-start text-sm">
              <input type="checkbox" checked={choices.toInbox} onChange={(e) => set({ toInbox: e.target.checked })} className="size-4 shrink-0 accent-accent" />
              {t("lists.toInbox")}
            </label>
          </div>
        )}
        <Footer>
          {nothing ? (
            <>
              <p role="status" className="mr-auto self-center text-xs text-muted">
                {t("lists.allHere")}
              </p>
              <Button variant="outline" size="lg" autoFocus onClick={close}>
                {t("common.close")}
              </Button>
            </>
          ) : (
            <>
              <p className="mr-auto self-center text-xs text-muted">{adding ? t("lists.willAdd", { what: adding }) : t("lists.nothingSaved")}</p>
              <Button variant="outline" size="lg" onClick={close}>
                {t("import.cancel")}
              </Button>
              <Button variant="primary" size="lg" disabled={!adding} onClick={() => void start()}>
                {t("lists.accept")}
              </Button>
            </>
          )}
        </Footer>
      </div>
    );
  };

  const reportPanel = (report: ListImportReport) => {
    const skipped = report.not_web + report.invalid + report.skipped_items;
    const lines = [
      [t("import.added"), report.added],
      report.already_saved > 0 && [t("import.existing"), report.already_saved],
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
          // A list of feeds only has no links to count: the bar alone says it is under way.
          shown.total > 0 ? <p>{t("import.progress", { done: shown.done, count: shown.total })}</p> : null,
          null,
          bar(shown.total ? Math.min(1, shown.done / total) : null, t("lists.importing")),
        );
      }
      case "report":
        return reportPanel(shown.report);
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
  return Number.isNaN(at.getTime()) ? day : at.toLocaleDateString(language, { day: "numeric", month: "short", year: "numeric" });
}

/**
 * The list's description in the header (K10): one line, and «more» when it is cut. Opened, it
 * takes two lines and scrolls beyond them, so the header stays within 110 px.
 */
function Description({ text }: { text: string }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLParagraphElement>(null);
  const [cut, setCut] = useState(false);
  const [whole, setWhole] = useState(false);
  useLayoutEffect(() => {
    const line = ref.current;
    if (!line || whole) return;
    const check = () => setCut(line.scrollWidth > line.clientWidth + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(line);
    return () => observer.disconnect();
  }, [text, whole]);
  const toggle = (label: string, to: boolean) => (
    <button type="button" onClick={() => setWhole(to)} className="shrink-0 font-medium text-accent hover:underline">
      {label}
    </button>
  );
  return whole ? (
    <p data-list-description className="max-h-[36px] shrink-0 overflow-y-auto text-sm [overflow-wrap:anywhere]">
      {text} {toggle(t("lists.less"), false)}
    </p>
  ) : (
    <div data-list-description className="flex min-w-0 items-baseline gap-1 text-sm">
      <p ref={ref} className="min-w-0 truncate">
        {text}
      </p>
      {cut && toggle(t("lists.more"), true)}
    </div>
  );
}

/** The virtualiser's key of a row: a row keeps its own state (an icon that failed) as rows above it fold or open. */
const keyOf = (row: PreviewRow) =>
  row.kind === "item" ? `i ${row.group} ${row.item.kind} ${row.item.url}` : row.kind === "notice" ? "notice" : `${row.kind} ${row.group}`;

/**
 * The preview's rows (K10a, K10b): one flat list, group headers included, virtualised, so a list of
 * 5,000 items draws only what is on screen and nothing nests a scroller of its own.
 */
function Rows({
  preview,
  rows,
  choices,
  tags,
  onChoose,
  onOpen,
}: {
  preview: ListPreview;
  rows: PreviewRow[];
  /** The new feeds that stay checked and the new links left out. */
  choices: ListChoices;
  /** «→ tag …» is shown: the sections become tags. */
  tags: boolean;
  onChoose: (change: Partial<Pick<ListChoices, "feeds" | "leaveOut">>) => void;
  onOpen: (group: number) => void;
}) {
  const { t, i18n } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index]?.kind === "notice" ? NOTICE_HEIGHT : rows[index]?.kind === "group" ? GROUP_HEIGHT : ROW_HEIGHT),
    getItemKey: (index) => keyOf(rows[index]),
    overscan: 8,
  });
  const number = (n: number) => n.toLocaleString(i18n.language);
  const chosen = choices.feeds;
  const checkedSet = useMemo(() => new Set(chosen), [chosen]);
  const leftOut = useMemo(() => new Set(choices.leaveOut), [choices.leaveOut]);

  // «Show N more» goes as its group opens: focus moves to the first row it showed, which takes
  // its place in the list, so the keyboard does not fall back to the page.
  const reveal = useRef<number | null>(null);
  const more = (group: number, index: number) => {
    reveal.current = index;
    onOpen(group);
  };
  useEffect(() => {
    const index = reveal.current;
    if (index === null) return;
    reveal.current = null;
    virtualizer.scrollToIndex(index, { align: "auto" });
    let tries = 0;
    const focus = () => {
      const shown = scrollRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
      const target = shown?.querySelector<HTMLElement>("input, button") ?? (shown?.firstElementChild as HTMLElement | null);
      if (target) target.focus({ preventScroll: true });
      else if (tries++ < 5) frame = requestAnimationFrame(focus);
    };
    let frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, [rows, virtualizer]);

  const notice = () => (
    <div className="pb-2">
      <div data-list-newer className="flex gap-2.5 rounded-xl bg-accent-soft p-3 text-xs">
        <Icon icon={Info} className="shrink-0 text-accent" />
        <div>
          <p className="font-medium text-ink">{t("lists.newer", { version: preview.meta.version })}</p>
          {preview.skipped_details + preview.skipped_items > 0 && (
            <p className="text-muted">
              {preview.skipped_details > 0 && preview.skipped_items > 0
                ? t("lists.newerText", { details: t("lists.details", { count: preview.skipped_details }), items: t("lists.items", { count: preview.skipped_items }) })
                : t("lists.newerSome", {
                    what: preview.skipped_details > 0 ? t("lists.details", { count: preview.skipped_details }) : t("lists.items", { count: preview.skipped_items }),
                  })}
            </p>
          )}
        </div>
      </div>
    </div>
  );

  const group = (row: Extract<PreviewRow, { kind: "group" }>) => {
    const name = row.name ?? t(row.feedsOnly ? "lists.groupFeeds" : "lists.groupLinks");
    const all = groupChoice(row, choices);
    return (
      <div data-list-group={name} className="flex h-9 items-end gap-2 pb-2 text-2xs">
        <Icon icon={row.feedsOnly ? Rss : row.name === null ? Link2 : Tag} size={12} className="mb-px shrink-0 text-icon" />
        <span className="min-w-0 truncate font-semibold tracking-[0.06em] text-icon uppercase">{name}</span>
        <span className="shrink-0 text-meta tabular-nums">{number(row.count)}</span>
        <span className="ml-auto" />
        {tags && row.tag && (
          <span data-list-tag className="min-w-0 shrink truncate text-xs text-meta">
            {t("lists.toTag", { tag: row.tag })}
          </span>
        )}
        {all && (
          <label className="flex shrink-0 items-center gap-2 text-xs text-muted">
            {t(row.feedsOnly ? "lists.followAll" : "lists.importAll")}
            <input
              type="checkbox"
              checked={all === "on"}
              ref={(box) => {
                if (box) box.indeterminate = all === "mixed";
              }}
              onChange={() => onChoose(toggleGroup(row, choices))}
              className="size-4 shrink-0 accent-accent"
            />
          </label>
        )}
      </div>
    );
  };

  const badge = (text: string, icon?: typeof Trash2) => (
    <span data-list-badge className="flex h-5 shrink-0 items-center gap-1 rounded-full bg-well px-2 text-2xs font-medium text-icon">
      {icon && <Icon icon={icon} size={11} />}
      {text}
    </span>
  );

  const item = (it: ListPreviewItem) => {
    const words = (
      <>
        <RowIcon item={it} />
        <span className="min-w-0 truncate">{it.title || it.host}</span>
        {it.title && <span className="min-w-0 shrink-[4] truncate text-xs text-meta">{it.host}</span>}
        <span className="ml-auto" />
      </>
    );
    const shape = "flex h-8 items-center gap-2.5 text-sm";
    if (it.kind === "feed" && it.status === "new") {
      const checked = checkedSet.has(it.url);
      return (
        <label data-list-row="new" title={it.url} className={shape}>
          {words}
          <input
            type="checkbox"
            checked={checked}
            onChange={() => onChoose({ feeds: checked ? chosen.filter((url) => url !== it.url) : [...chosen, it.url] })}
            className="size-4 shrink-0 accent-accent"
          />
        </label>
      );
    }
    if (it.kind === "link" && it.status === "new") {
      const checked = !leftOut.has(it.url);
      return (
        <label data-list-row="new" title={it.url} className={shape}>
          {words}
          <input type="checkbox" checked={checked} onChange={() => onChoose({ leaveOut: toggleLink(it.url, choices) })} className="size-4 shrink-0 accent-accent" />
        </label>
      );
    }
    return (
      <div data-list-row={it.status} title={it.url} tabIndex={-1} className={`${shape} outline-none`}>
        {words}
        {it.status === "saved" && badge(t("lists.badgeSaved"))}
        {it.status === "in_trash" && badge(t("lists.badgeTrash"), Trash2)}
        {it.status === "followed" && badge(t("lists.following"))}
      </div>
    );
  };

  const row = (r: PreviewRow, index: number) => {
    switch (r.kind) {
      case "notice":
        return notice();
      case "group":
        return group(r);
      case "item":
        return item(r.item);
      case "more":
        return (
          <button type="button" onClick={() => more(r.group, index)} className="h-8 pl-[26px] text-xs font-medium text-accent hover:underline">
            {t("lists.showRows", { count: r.count })}
          </button>
        );
    }
  };

  return (
    <div ref={scrollRef} data-list-rows className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 py-2">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((v) => (
          <div key={v.key} data-index={v.index} ref={virtualizer.measureElement} className="absolute top-0 left-0 w-full" style={{ transform: `translateY(${v.start}px)` }}>
            {row(rows[v.index], v.index)}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A row's icon (K10): the local copy of a saved bookmark's or a followed feed's icon, which the
 * library already has; else a monogram, or the feed mark. A host that is only in the list is never
 * asked for anything.
 */
function RowIcon({ item }: { item: ListPreviewItem }) {
  const src =
    item.kind === "link"
      ? item.status !== "new" && item.bookmark_id !== null
        ? localPictureSrc("bookmark-icon", item.bookmark_id)
        : null
      : item.status === "followed" && item.feed_uid
        ? localPictureSrc("feed-icon", item.feed_uid)
        : null;
  const [failed, setFailed] = useState(false);
  // The backend's 1×1 answer for an address it refuses: no icon.
  const loaded = (e: SyntheticEvent<HTMLImageElement>) => e.currentTarget.naturalWidth === 1 && e.currentTarget.naturalHeight === 1 && setFailed(true);
  if (src && !failed) return <img src={src} alt="" className="size-4 shrink-0 rounded-xs object-contain" onError={() => setFailed(true)} onLoad={loaded} />;
  if (item.kind === "feed")
    return (
      <span aria-hidden className="flex size-4 shrink-0 items-center justify-center rounded-xs bg-accent-soft text-accent">
        <Icon icon={Rss} size={11} />
      </span>
    );
  return (
    <span
      aria-hidden
      className="flex size-4 shrink-0 items-center justify-center rounded-full text-[9px] leading-none font-semibold text-white"
      style={{ background: PALETTE[hash(item.host.toLowerCase()) % PALETTE.length][1] }}
    >
      {monogram(item.host, item.title ?? "")}
    </span>
  );
}
