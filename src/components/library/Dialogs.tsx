import { ReactNode, useState } from "react";
import { ArrowDownToLine, Link } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Browser, CaptureStatus, Collection } from "../../types";
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

export function ImportDialog({ onImport, onClose }: { onImport: (content: string) => Promise<void>; onClose: () => void }) {
  const { t } = useTranslation();
  const { busy, error, setError, run } = useAction();
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  return (
    <Dialog title={t("import.title")} onClose={() => !busy && onClose()}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">{t("import.lead")}</p>
        <label className="flex cursor-default flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-7 text-sm text-muted hover:bg-panel focus-within:outline-2 focus-within:outline-accent">
          <Icon icon={ArrowDownToLine} size={22} />
          <span>{file?.name ?? t("import.file")}</span>
          <input
            type="file"
            accept=".html,.htm"
            className="sr-only"
            onChange={(e) => {
              const picked = e.target.files?.[0];
              if (picked)
                void picked
                  .text()
                  .then((content) => setFile({ name: picked.name, content }))
                  .catch((err) => setError(describeError(err)));
            }}
          />
        </label>
        <Failure error={error} />
        <Footer>
          <Button variant="primary" size="lg" disabled={busy || !file} onClick={() => file && void run(() => onImport(file.content))}>
            {busy ? t("import.running") : t("import.run")}
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
