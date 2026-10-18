import { KeyboardEvent, ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Pencil, Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { bundle, BundleSnapshot, BundleState, itemCount, TITLE_LEN, titleOf, toModel } from "../../services/bundle";
import { bundleApi } from "../../services/bundleApi";
import { describeError } from "../../services/errors";
import { listMarkdown, MAX_BYTES, readDraft, slugify } from "../../services/listText";
import type { BundleModel } from "../../bindings/BundleModel";
import { savePreference, storedValue } from "../../services/preferences";
import { Icon } from "../icons";
import { Button } from "../ui/Button";
import { pruneBundle } from "./actions";
import { EmptyState } from "./EmptyState";
import { Section } from "./Section";

/** The bundle is built again this long after its last change while the panel is open. */
const BUILD_DELAY = 250;
/** Above this the footer shows the size, in ochre; over `MAX_BYTES` it is an error. */
const SIZE_SHOWN = 1.6 * 1024 * 1024;
const NOTICE_MS = 8000;
/** The Author name is remembered as in 2.4.0: a preference, not bundle content. */
const AUTHOR_NAME = "share.authorName";

type Notice = { text: string; actions: { label: string; run: () => void }[]; alert?: boolean };
/** The last build: its text and size, or, past a limit, the size it would have and no text; or why it failed. */
type Built = { text: string; bytes: number; over: boolean } | { error: string };

/**
 * The bundle panel (K7a, K7b): 380 px, non-modal, its bottom 12 px above the capsule in every
 * state. The header holds the inline title, the meta line, «Add description and author», Clear
 * and ×; «Add {view} · N» sits under the meta line; the middle scrolls the sections; the footer
 * has Copy as Markdown and Save .kpin…, with the notices of Save, Copy and Clear above them.
 */
export function Panel({
  id,
  state,
  bottom,
  height,
  dragging,
  over,
  add,
  onClose,
}: {
  id: string;
  state: BundleState;
  bottom: number;
  height: number;
  dragging: boolean;
  over: boolean;
  /** «Add {view} · N», while the view on screen can be added. */
  add: { label: string; onAdd: () => void } | null;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const root = useRef<HTMLDivElement>(null);
  const emptyButton = useRef<HTMLButtonElement>(null);
  const [details, setDetails] = useState(() => !!state.description || !!state.author);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [built, setBuilt] = useState<Built | null>(null);
  const title = titleOf(state, t);
  const count = itemCount(state);
  const empty = count === 0;

  // The remembered Author name fills an empty field.
  useEffect(() => {
    if (!bundle.get().author) bundle.setAuthor(storedValue(AUTHOR_NAME) ?? "");
  }, []);
  // Opening focuses the first row, or the empty state's button.
  useLayoutEffect(() => {
    const first = root.current?.querySelector<HTMLElement>("[data-bundle-row] button") ?? emptyButton.current;
    (first ?? root.current?.querySelector<HTMLElement>("button"))?.focus();
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // The model changes only with what goes into the list, not with the panel's own state.
  const model = useMemo(
    () => toModel(state, t),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.sections, state.title, state.titleEdited, state.description, state.author, t],
  );
  const latest = useRef(model);
  latest.current = model;
  // The background build only drives the size line, so it follows the sections: a title,
  // description or author typed in cannot take a list over its limits in a way that matters.
  // Save and Copy always build anew.
  const runs = useRef(0);
  useEffect(() => {
    if (empty) return setBuilt(null);
    const run = ++runs.current;
    const timer = window.setTimeout(() => void build(latest.current).then((next) => run === runs.current && setBuilt(next)), BUILD_DELAY);
    return () => window.clearTimeout(timer);
  }, [state.sections, empty]);
  /** Builds the list; items gone from the library leave the bundle with their meta line. */
  const build = async (next: BundleModel): Promise<Built> => {
    try {
      const result = await bundleApi.build(next);
      if (result.left > 0) void pruneBundle();
      if (result.too_big !== null) return { text: "", bytes: result.too_big, over: true };
      return { text: result.text, bytes: new TextEncoder().encode(result.text).length, over: false };
    } catch (err) {
      return { error: describeError(err) };
    }
  };
  const bytes = built && "text" in built ? built.bytes : 0;
  const tooBig = !!built && "over" in built && built.over;
  const megabytes = (n: number) => new Intl.NumberFormat(i18n.language, { style: "unit", unit: "megabyte", maximumFractionDigits: 1 }).format(n / 1024 / 1024);
  const sizeLine = tooBig
    ? bytes > MAX_BYTES
      ? t("bundle.tooBig", { size: megabytes(bytes) })
      : t("bundle.tooBigNoSize")
    : built && "error" in built
      ? built.error
      : bytes > SIZE_SHOWN
        ? t("bundle.size", { size: megabytes(bytes) })
        : "";
  const blocked = empty || tooBig || busy;

  /**
   * The text for what is on screen now, always built anew: a bookmark trashed since the last build
   * is never written, whatever the model says.
   */
  const fresh = async (): Promise<string | null> => {
    const run = ++runs.current;
    const result = await build(model);
    if (run === runs.current) setBuilt(result);
    return "text" in result && !result.over ? result.text : null;
  };
  // A second click before the first one's dialog is up would open another: the guard is a ref,
  // set at once, not `busy`, which only changes on the next render.
  const inFlight = useRef(false);
  const save = async () => {
    if (blocked || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const text = await fresh();
      if (!text) return;
      const result = await bundleApi.save(text, slugify(title), title);
      if (result.outcome === "cancelled") return;
      if (result.outcome === "saved")
        return setNotice({
          text: t("bundle.saved", { name: result.file_name }),
          actions: [
            { label: t("export.show"), run: () => void bundleApi.reveal().catch((err) => setNotice({ text: describeError(err), actions: [], alert: true })) },
            { label: t("bundle.clear"), run: clear },
          ],
        });
      const { file_name: name, folder, detail } = result;
      setNotice({
        alert: true,
        actions: [],
        text:
          result.problem === "disk_full"
            ? t("export.diskFull", { name })
            : result.problem === "no_permission"
              ? t("export.noPermission", { folder })
              : result.problem === "in_use"
                ? t("export.inUse", { name })
                : t("export.other", { name, detail }),
      });
    } catch (err) {
      setNotice({ text: describeError(err), actions: [], alert: true });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const copy = async () => {
    if (blocked || inFlight.current) return;
    inFlight.current = true;
    try {
      const text = await fresh();
      if (!text) return;
      const draft = readDraft(text);
      await navigator.clipboard.writeText(listMarkdown(draft, t("bundle.feedWord")));
      setNotice({ text: t("bundle.copied", { count: draft.links + draft.feeds }), actions: [] });
    } catch {
      setNotice({ text: t("notice.copyFailed"), actions: [], alert: true });
    } finally {
      inFlight.current = false;
    }
  };
  const clear = () => {
    const snapshot: BundleSnapshot = bundle.clear();
    setOpenRow(null);
    setNotice({
      text: t("bundle.cleared"),
      actions: [
        {
          label: t("notice.undo"),
          run: () => {
            bundle.restore(snapshot);
            setNotice(null);
          },
        },
      ],
    });
    requestAnimationFrame(() => (emptyButton.current ?? root.current?.querySelector<HTMLElement>("button"))?.focus());
  };
  /** A removed row hands the focus to the next one, else the one before. */
  const removeEntry = (entryKey: string) => {
    const rows = [...(root.current?.querySelectorAll<HTMLElement>("[data-bundle-row] > button[aria-expanded]") ?? [])];
    const at = rows.findIndex((row) => row === document.activeElement);
    bundle.removeEntry(entryKey);
    if (at < 0) return;
    requestAnimationFrame(() => {
      const next = [...(root.current?.querySelectorAll<HTMLElement>("[data-bundle-row] > button[aria-expanded]") ?? [])];
      (next[Math.min(at, next.length - 1)] ?? emptyButton.current ?? root.current?.querySelector<HTMLElement>("button"))?.focus();
    });
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
  };

  const onlyLinks = state.sections.length === 1 && state.sections[0].origin.kind === "links";
  const meta = empty ? t("bundle.metaEmpty") : t("bundle.meta", { count });
  return (
    <div
      ref={root}
      id={id}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-bundle-panel
      data-drop={dragging ? "bundle" : undefined}
      data-over={over || undefined}
      onKeyDown={keys}
      style={{ bottom, height }}
      className={`bundle-panel absolute right-6 z-40 flex w-[380px] max-w-[calc(100%-48px)] animate-appear flex-col overflow-hidden rounded-3xl text-ink ${over ? "outline-2 outline-accent" : ""}`}
    >
      <header className="flex shrink-0 flex-col gap-0.5 border-b border-divider px-4 pt-3 pb-2">
        <div className="flex items-center gap-1">
          <h2 id={titleId} className="sr-only">
            {title}
          </h2>
          <label className="group/title flex min-w-0 flex-1 items-center gap-1.5">
            <span className="sr-only">{t("bundle.titleLabel")}</span>
            {/* As wide as its text, so the pencil follows the title: the input over a hidden copy of it. */}
            <span className="-ml-1 grid min-w-0 text-md font-semibold">
              <span aria-hidden className="invisible col-start-1 row-start-1 truncate px-1 py-0.5 whitespace-pre">
                {title || " "}
              </span>
              <input
                value={title}
                maxLength={TITLE_LEN}
                onChange={(e) => bundle.setTitle(e.target.value)}
                size={1}
                className={`peer col-start-1 row-start-1 w-full min-w-0 truncate rounded-md bg-transparent px-1 py-0.5 outline-none hover:bg-hover focus:bg-hover ${empty && !state.titleEdited ? "text-muted" : ""}`}
              />
            </span>
            <Icon icon={Pencil} size={13} className="shrink-0 text-subtle opacity-60 group-hover/title:opacity-100 group-focus-within/title:opacity-100" />
          </label>
          {!empty && (
            <button type="button" onClick={clear} className="h-7 shrink-0 rounded-md px-2 text-sm text-icon hover:bg-hover hover:text-ink">
              {t("bundle.clear")}
            </button>
          )}
          <button
            type="button"
            aria-label={t("bundle.close")}
            title={t("bundle.close")}
            onClick={onClose}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-icon hover:bg-hover hover:text-ink"
          >
            <Icon icon={X} size={15} />
          </button>
        </div>
        <p data-bundle-meta className="truncate text-xs text-muted">
          {meta}
          {state.left > 0 && <span className="text-ochre"> · {t("bundle.left", { count: state.left })}</span>}
        </p>
        {details ? (
          <div className="mt-1.5 flex flex-col gap-1.5">
            <textarea
              aria-label={t("bundle.description")}
              placeholder={t("bundle.description")}
              rows={2}
              maxLength={2000}
              value={state.description}
              onChange={(e) => bundle.setDescription(e.target.value)}
              className="field resize-none text-sm"
            />
            <input
              aria-label={t("bundle.author")}
              placeholder={t("bundle.author")}
              maxLength={120}
              value={state.author}
              onChange={(e) => {
                bundle.setAuthor(e.target.value);
                savePreference(AUTHOR_NAME, e.target.value);
              }}
              className="field text-sm"
            />
          </div>
        ) : (
          <button type="button" onClick={() => setDetails(true)} className="self-start text-xs font-medium text-accent hover:underline">
            {t("bundle.addDetails")}
          </button>
        )}
        {!empty && add && (
          <button
            type="button"
            data-bundle-add
            onClick={add.onAdd}
            className="mt-1 -ml-1.5 flex h-8 items-center gap-1.5 self-start rounded-md px-1.5 text-sm font-medium text-ink hover:bg-hover"
          >
            <Icon icon={Plus} size={15} className="text-accent" />
            {add.label}
          </button>
        )}
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-1.5" data-bundle-list>
        {empty ? (
          <EmptyState ref={emptyButton} add={add} />
        ) : (
          state.sections.map((section) => (
            <Section
              key={section.key}
              section={section}
              name={section.origin.kind === "links" ? t("bundle.links") : section.origin.kind === "feeds" ? t("bundle.feeds") : section.name}
              header={!onlyLinks}
              flash={state.flash?.key === section.key ? state.flash.nonce : null}
              openRow={openRow}
              onOpenRow={setOpenRow}
              onRemove={() => bundle.removeSection(section.key)}
              onRemoveEntry={removeEntry}
              onUseNote={(entry, use) => bundle.setUseNote(entry, use)}
            />
          ))
        )}
      </div>
      <footer className="flex shrink-0 flex-col gap-2 border-t border-divider px-4 py-3">
        {notice && (
          <p role={notice.alert ? "alert" : "status"} className={`flex flex-wrap items-center gap-x-2 text-xs ${notice.alert ? "text-danger" : "text-ink"}`}>
            <span className="[overflow-wrap:anywhere]">{notice.text}</span>
            {notice.actions.map((action) => (
              <Dotted key={action.label}>
                <button type="button" onClick={action.run} className="font-semibold text-accent hover:underline">
                  {action.label}
                </button>
              </Dotted>
            ))}
          </p>
        )}
        {sizeLine && (
          <p data-bundle-size role={tooBig ? "alert" : undefined} className={`text-xs [overflow-wrap:anywhere] ${tooBig || (built && "error" in built) ? "text-danger" : "text-ochre"}`}>
            {sizeLine}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="lg" disabled={blocked} onClick={() => void copy()}>
            {t("bundle.copy")}
          </Button>
          <Button variant="primary" size="lg" disabled={blocked} onClick={() => void save()}>
            {t("bundle.save")}
          </Button>
        </div>
      </footer>
    </div>
  );
}

const Dotted = ({ children }: { children: ReactNode }) => (
  <>
    <span aria-hidden className="text-subtle">
      ·
    </span>
    {children}
  </>
);
