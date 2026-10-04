import { ReactNode, useEffect, useState } from "react";
import { CircleCheck, FileText, Folder, Link } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Browser, CaptureStatus, Collection, ImportProgress, ImportSummary } from "../../types";
import { api } from "../../services/api";
import { ParsedFile, parseBookmarksFile } from "../../services/bookmarksFile";
import { describeError } from "../../services/errors";
import {
  browserName,
  browsers,
  connectedNames,
  installSteps,
  lastSaved,
  preferredBrowser,
  statusColor,
  statusLabel,
} from "../../services/capture";
import { Icon } from "../icons";
import { Button } from "../ui/Button";
import { Dot, Field, Segmented } from "../ui/Controls";
import { Dialog } from "../ui/Dialog";
import { CollectionSelect, TagInput } from "./Fields";

/** Runs an action, keeps the dialog and its input on failure. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

const Failure = ({ error }: { error: string }) =>
  error ? (
    <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2.5 text-sm text-on-danger-soft">
      {error}
    </p>
  ) : null;

const Footer = ({ children }: { children: ReactNode }) => <footer className="mt-1 flex justify-end gap-2">{children}</footer>;

export function AddLinkDialog({
  collections,
  collectionId,
  onAdd,
  onClose,
}: {
  collections: Collection[];
  collectionId: number | null;
  onAdd: (data: { url: string; title?: string; collectionId: number | null; tags: string[] }) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { busy, error, setError, run } = useAction();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [collection, setCollection] = useState(collectionId);
  const [tags, setTags] = useState<string[]>([]);
  return (
    <Dialog title={t("add.title")} onClose={() => !busy && onClose()}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() =>
            onAdd({
              url: url.trim(),
              title: title.trim() || undefined,
              collectionId: collection,
              tags,
            }),
          );
        }}
      >
        <p className="text-sm text-muted">{t("add.lead")}</p>
        <Field label={t("add.url")}>
          {(id) => (
            <div className="flex flex-col gap-1.5">
              <input id={id} autoFocus required type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" className="field" />
              <button
                type="button"
                className="self-start text-xs text-muted hover:text-ink"
                onClick={() => {
                  void navigator.clipboard
                    .readText()
                    .then((text) => setUrl(text.trim()))
                    .catch(() => setError(t("add.clipboardUnavailable")));
                }}
              >
                {t("add.paste")}
              </button>
            </div>
          )}
        </Field>
        <Field label={t("add.name")}>
          {(id) => <input id={id} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("add.optional")} className="field" />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("editor.collection")}>
            {(id) => <CollectionSelect id={id} value={collection} collections={collections} onChange={setCollection} />}
          </Field>
          <Field label={t("editor.tags")}>{(id) => <TagInput id={id} tags={tags} onChange={setTags} />}</Field>
        </div>
        <Failure error={error} />
        <Footer>
          <Button variant="primary" size="lg" type="submit" disabled={busy}>
            {busy ? t("add.saving") : t("add.save")}
          </Button>
        </Footer>
      </form>
    </Dialog>
  );
}

/** Frame 28: the file and where to put it, progress, the report, an error with nothing changed. */
export function ImportDialog({
  onImport,
  onOpenInbox,
  onClose,
}: {
  onImport: (content: string, toInbox: boolean) => Promise<ImportSummary>;
  onOpenInbox: () => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [file, setFile] = useState<{ name: string; content: string; preview: ParsedFile } | null>(null);
  const [toInbox, setToInbox] = useState(false);
  const [running, setRunning] = useState<ImportProgress | null>(null);
  const [report, setReport] = useState<ImportSummary | null>(null);
  const [error, setError] = useState("");
  const [showSkipped, setShowSkipped] = useState(false);
  useEffect(() => api.onImportProgress((progress) => setRunning((current) => current && progress)), []);
  const empty = !!file && file.preview.links.length === 0 && file.preview.skipped.length === 0;
  const start = async () => {
    if (!file) return;
    setError("");
    setRunning({ done: 0, total: file.preview.links.length });
    try {
      setReport(await onImport(file.content, toInbox));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setRunning(null);
    }
  };

  if (report) {
    const skipped = report.not_web + report.invalid + report.repeated;
    const shown = report.collections.slice(0, 2).join(", ");
    const names = report.collections.length > 2 ? t("import.andMore", { names: shown, count: report.collections.length - 2 }) : shown;
    const created = [
      report.collections.length > 0 && t("import.collections", { count: report.collections.length, names }),
      report.tags > 0 && t("import.tags", { count: report.tags }),
    ].filter(Boolean);
    const row = (label: string, count: number) => (
      <div className="flex items-center justify-between gap-3 border-t border-divider py-2 text-sm first:border-t-0">
        <span>{label}</span>
        <span className="font-medium tabular-nums">{count.toLocaleString(i18n.language)}</span>
      </div>
    );
    return (
      <Dialog title={t("import.finished")} onClose={onClose}>
        <div className="flex flex-col gap-4">
          <div className="flex gap-2.5">
            <Icon icon={CircleCheck} size={18} className="mt-px shrink-0 text-accent" />
            <div className="min-w-0">
              <p role="status" className="text-md font-semibold">
                {report.added > 0
                  ? t(toInbox ? "import.addedInbox" : "import.addedLibrary", { count: report.added })
                  : t("import.nothingNew")}
              </p>
              {created.length > 0 && <p className="mt-0.5 text-xs text-muted">{created.join(" · ")}</p>}
            </div>
          </div>
          <div className="border-y border-divider">
            {row(t("import.added"), report.added)}
            {row(t("import.existing"), report.existing)}
            {report.in_trash > 0 && row(t("import.inTrash"), report.in_trash)}
            {row(t("import.skipped"), skipped)}
            {skipped > 0 && (
              <div className="flex flex-col gap-1.5 pb-3 pl-4 text-xs text-muted">
                {(["not_web", "invalid", "repeated"] as const).map(
                  (reason) =>
                    report[reason] > 0 && (
                      <div key={reason} className="flex justify-between gap-3">
                        <span>{t(`import.reason_${reason}`)}</span>
                        <span className="tabular-nums">{report[reason].toLocaleString(i18n.language)}</span>
                      </div>
                    ),
                )}
                <button
                  type="button"
                  aria-expanded={showSkipped}
                  onClick={() => setShowSkipped(!showSkipped)}
                  className="mt-1.5 self-start font-medium text-accent hover:underline"
                >
                  {showSkipped ? t("import.hideSkipped") : t("import.showSkipped")}
                </button>
                {showSkipped && (
                  <ul className="max-h-40 overflow-y-auto rounded-lg bg-secondary px-3 py-2 text-subtle">
                    {report.skipped.map((s, i) => (
                      <li key={i} className="truncate" title={`${s.address} — ${t(`import.reason_${s.reason}`)}`}>
                        {s.address || "—"}
                      </li>
                    ))}
                    {skipped > report.skipped.length && <li>{t("import.moreSkipped", { count: skipped - report.skipped.length })}</li>}
                  </ul>
                )}
              </div>
            )}
          </div>
          <Footer>
            {toInbox && report.added > 0 && (
              <Button variant="outline" size="lg" onClick={onOpenInbox}>
                {t("import.openInbox")}
              </Button>
            )}
            <Button variant="primary" size="lg" autoFocus onClick={onClose}>
              {t("import.done")}
            </Button>
          </Footer>
        </div>
      </Dialog>
    );
  }

  if (running && file) {
    const total = Math.max(running.total, 1);
    return (
      <Dialog title={t("import.title")} onClose={onClose} locked>
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium [overflow-wrap:anywhere]">{t("import.importing", { name: file.name })}</p>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={running.total}
            aria-valuenow={running.done}
            aria-label={t("import.importing", { name: file.name })}
            className="h-1 overflow-hidden rounded-full bg-hover"
          >
            <div className="h-full rounded-full bg-accent transition-[width] duration-150" style={{ width: `${(running.done / total) * 100}%` }} />
          </div>
          <p className="text-xs text-muted">{t("import.progress", { done: running.done, count: running.total })}</p>
          <p className="text-xs text-subtle">{t("import.progressNote")}</p>
          <Footer>
            <Button variant="primary" size="lg" disabled>
              {t("import.running")}
            </Button>
          </Footer>
        </div>
      </Dialog>
    );
  }

  const summary = file && [
    t("import.links", { count: file.preview.links.length }),
    file.preview.folders > 0 ? t("import.inFolders", { count: file.preview.folders }) : "",
  ].filter(Boolean).join(" ");
  return (
    <Dialog title={t("import.title")} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">{t("import.lead")}</p>
        {error && file ? (
          <div className="flex items-center gap-2.5 rounded-xl bg-secondary px-3 py-3 text-sm">
            <Icon icon={FileText} className="shrink-0 text-icon" />
            <span className="min-w-0 flex-1 truncate font-medium">{file.name}</span>
            <span className="shrink-0 text-xs text-subtle">{t("import.links", { count: file.preview.links.length })}</span>
          </div>
        ) : (
          <label className="flex cursor-default flex-col items-center gap-1 rounded-xl border border-dashed border-border px-4 py-4 text-center text-sm hover:bg-panel focus-within:outline-2 focus-within:outline-accent">
            <Icon icon={FileText} size={22} className="mb-1.5 text-icon" />
            <span className={file ? "font-medium [overflow-wrap:anywhere]" : "text-muted"}>{file?.name ?? t("import.file")}</span>
            {file && <span className="text-xs text-subtle">{`${summary} · ${t("import.another")}`}</span>}
            <input
              type="file"
              accept=".html,.htm"
              className="sr-only"
              onChange={(e) => {
                const picked = e.target.files?.[0];
                if (picked)
                  void picked
                    .text()
                    .then((content) => {
                      setError("");
                      setFile({ name: picked.name, content, preview: parseBookmarksFile(content) });
                    })
                    .catch((err) => setError(describeError(err)));
              }}
            />
          </label>
        )}
        {empty && <Failure error={t("import.empty")} />}
        {!error && (
          <>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted">{t("import.destination")}</span>
              <div className="flex">
                <Segmented<"library" | "inbox">
                  label={t("import.destination")}
                  value={toInbox ? "inbox" : "library"}
                  onChange={(value) => setToInbox(value === "inbox")}
                  options={[
                    { value: "library", label: t("import.library") },
                    { value: "inbox", label: t("import.inbox") },
                  ]}
                />
              </div>
              <p className="text-xs text-subtle">{t("import.destinationHint")}</p>
            </div>
            <div className="flex gap-2.5 rounded-xl bg-secondary p-3 text-xs text-icon">
              <Icon icon={Folder} className="shrink-0" />
              <p>{t("import.rule")}</p>
            </div>
          </>
        )}
        {error && <Failure error={file ? t("import.failed", { reason: error }) : error} />}
        <Footer>
          <Button variant="outline" size="lg" onClick={onClose}>
            {t("import.cancel")}
          </Button>
          <Button variant="primary" size="lg" disabled={!file || empty} onClick={() => void start()}>
            {error && file ? t("common.retry") : t("import.run")}
          </Button>
        </Footer>
      </div>
    </Dialog>
  );
}

export function CollectionDialog({ onCreate, onClose }: { onCreate: (name: string) => Promise<void>; onClose: () => void }) {
  const { t } = useTranslation();
  const { busy, error, run } = useAction();
  const [name, setName] = useState("");
  return (
    <Dialog title={t("collection.title")} onClose={() => !busy && onClose()} width={400}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => onCreate(name.trim()));
        }}
      >
        <Field label={t("collection.name")}>
          {(id) => (
            <input id={id} autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder={t("collection.placeholder")} className="field" />
          )}
        </Field>
        <Failure error={error} />
        <Footer>
          <Button variant="primary" size="lg" type="submit" disabled={busy}>
            {t("collection.create")}
          </Button>
        </Footer>
      </form>
    </Dialog>
  );
}

export function ConfirmDialog({
  title,
  text,
  confirm,
  onConfirm,
  onClose,
}: {
  title: string;
  text: string;
  confirm: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { busy, error, run } = useAction();
  return (
    <Dialog title={title} onClose={() => !busy && onClose()} width={400}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted [overflow-wrap:anywhere]">{text}</p>
        <Failure error={error} />
        <Footer>
          <Button disabled={busy} onClick={onClose}>
            {t("common.keep")}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void run(onConfirm)}>
            {confirm}
          </Button>
        </Footer>
      </div>
    </Dialog>
  );
}

/** Frame 18: how to connect, reconnect and update the extension in each browser. */
export function ConnectDialog({
  capture,
  onOpen,
  onClose,
}: {
  capture: CaptureStatus | null;
  onOpen: (url: string) => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [browser, setBrowser] = useState<Browser>(() => preferredBrowser(capture));
  const status =
    capture?.state === "connected"
      ? `${t("browser.connectedTo", { browsers: connectedNames(capture) })} · ${lastSaved(capture, t, i18n.language)}`
      : statusLabel(capture, t);
  const install = installSteps(browser);
  const steps = [
    {
      title: t("connect.installTitle"),
      text: t(install.install),
      action: install.url ? (
        <Button className="mt-2" onClick={() => onOpen(install.url)}>
          {t("connect.openStore", { store: install.store })}
        </Button>
      ) : null,
    },
    { title: t("connect.pinTitle"), text: t(`connect.pin_${browser}`), action: null },
    { title: t("connect.saveTitle"), text: t("connect.save"), action: null },
  ];
  return (
    <Dialog title={t("connect.title")} onClose={onClose}>
      <div className="flex w-[440px] max-w-full flex-col gap-4 text-sm">
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-secondary text-icon">
            <Icon icon={Link} />
          </span>
          <div className="min-w-0">
            <h3 className="text-md font-semibold">{t("connect.lead")}</h3>
            <p data-capture={capture?.state ?? "checking"} className="mt-0.5 flex items-center gap-2 text-xs text-muted">
              <Dot color={statusColor(capture)} className="size-1.5" />
              {status}
            </p>
          </div>
        </div>
        <Segmented<Browser>
          label={t("connect.browsers")}
          value={browser}
          onChange={setBrowser}
          options={browsers.map((value) => ({ value, label: browserName[value] }))}
        />
        <ol className="flex flex-col gap-4">
          {steps.map((step, index) => (
            <li key={step.title} className="flex gap-3">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-2xs font-semibold text-on-accent-soft">
                {index + 1}
              </span>
              <div>
                <div className="font-medium">{step.title}</div>
                <p className="mt-0.5 leading-[18px] text-muted">{step.text}</p>
                {step.action}
              </div>
            </li>
          ))}
        </ol>
        <div className="flex flex-col gap-3 border-t border-divider pt-4">
          <div>
            <div className="font-medium">{t("connect.lostTitle")}</div>
            <p className="mt-0.5 leading-[18px] text-muted">{t(`connect.lost_${browser}`)}</p>
          </div>
          <div>
            <div className="font-medium">{t("connect.updateTitle")}</div>
            <p className="mt-0.5 leading-[18px] text-muted">{t(install.update)}</p>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
