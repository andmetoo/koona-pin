import { ReactNode, useState } from "react";
import { ArrowDownToLine, Bookmark as BookmarkIcon, ChevronDown, Copy, Link } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AppSettings, Collection, ServerStatus } from "../../types";
import { describeError } from "../../services/errors";
import { Icon } from "../icons";
import { Button, IconButton } from "../ui/Button";
import { Dot, Field } from "../ui/Controls";
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

export function ConnectDialog({
  settings,
  server,
  bookmarklet,
  desktop,
  error,
  onCopy,
  onClose,
}: {
  settings: AppSettings | null;
  server: ServerStatus | null;
  bookmarklet: string;
  desktop: boolean;
  error: string;
  onCopy: (text: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [alternative, setAlternative] = useState(false);
  return (
    <Dialog title={t("connect.title")} onClose={onClose}>
      <div className="flex flex-col gap-4 text-sm">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-full bg-secondary text-icon">
            <Icon icon={Link} size={20} />
          </span>
          <h3 className="text-md font-semibold">{t("connect.lead")}</h3>
        </div>
        <p data-connection={server?.running ? "running" : "stopped"} className="flex items-center gap-2 text-xs text-muted">
          <Dot color={server?.running ? "var(--np-green)" : server?.error ? "var(--np-danger)" : "var(--np-faint)"} className="size-1.5" />
          {server?.running ? t("connect.ready") : server?.error || t("connect.checking")}
        </p>
        <p className="text-muted">{t("connect.install")}</p>
        {desktop ? (
          <Field label={t("connect.token")}>
            {(id) => (
              <div className="flex items-center gap-2">
                <input id={id} readOnly type="password" value={settings?.capture_token ?? ""} className="field" />
                <IconButton label={t("connect.copyToken")} disabled={!settings?.capture_token} onClick={() => settings && onCopy(settings.capture_token)}>
                  <Icon icon={Copy} />
                </IconButton>
              </div>
            )}
          </Field>
        ) : (
          <p className="rounded-xl bg-panel px-3 py-2.5 text-xs text-muted">{t("connect.desktopOnly")}</p>
        )}
        <p className="text-muted">{t("connect.queue")}</p>
        <Button className="self-start" onClick={() => setAlternative(!alternative)} aria-expanded={alternative}>
          <Icon icon={BookmarkIcon} size={15} />
          {t("connect.bookmarklet")}
          <Icon icon={ChevronDown} size={14} />
        </Button>
        {alternative && (
          <div className="flex flex-col gap-3 text-xs text-muted">
            <p>{t("connect.bookmarkletHow")}</p>
            <div className="flex gap-2">
              <a
                className="inline-flex h-[30px] cursor-grab items-center rounded-md bg-accent px-3 text-sm font-semibold text-on-accent no-underline"
                ref={(element) => {
                  element?.setAttribute("href", bookmarklet);
                }}
                draggable
                onClick={(e) => e.preventDefault()}
              >
                {t("connect.bookmarkletButton")}
              </a>
              <Button onClick={() => onCopy(bookmarklet)}>{t("connect.copyCode")}</Button>
            </div>
            <small>{t("connect.bookmarkletLimits")}</small>
          </div>
        )}
        <Failure error={error} />
      </div>
    </Dialog>
  );
}
