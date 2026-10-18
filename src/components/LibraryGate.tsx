import { ReactNode, useEffect, useRef, useState } from "react";
import { CircleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, isTauri } from "../services/api";
import { capabilities } from "../platform/capabilities";
import { describeError } from "../services/errors";
import { LibraryStatus, OpenFailure } from "../types";
import { Icon } from "./icons";
import { BackupRestoreDialog } from "./BackupRestoreDialog";
import { Button } from "./ui/Button";
import { WindowBar } from "./ui/WindowBar";

const ready: LibraryStatus = { state: "ready", damaged: false, moved_aside: null };

/** Codes after which «Try again» cannot help: only a newer app or support can. */
const final: OpenFailure["code"][] = ["DB_NEWER_SCHEMA", "MIGRATION_FAILED"];
/** A file that is not a working library: a backup can take its place (NP-034). */
const replaceable: OpenFailure["code"][] = ["DB_CORRUPT", "DB_NOT_DATABASE", "DB_FOREIGN"];

/**
 * Shows the library only once it has opened. Until then: nothing for the
 * first 300 ms, then «Opening…»; when opening fails, the screen of frame
 * «12 · Ошибки» instead of the library. Database commands are not called
 * before the library is ready.
 */
export function LibraryGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<LibraryStatus>(isTauri() ? { state: "opening" } : ready);
  const [slow, setSlow] = useState(false);
  const [restoring, setRestoring] = useState(false);
  /** Set once a backup took the broken file's place; the library is opening again. */
  const restored = useRef(false);
  useEffect(() => {
    if (status.state !== "opening") return;
    let stopped = false;
    let timer = 0;
    // The event can fire before the listener is registered, so the status
    // is also polled until it changes.
    const off = api.onLibraryStatus((next) => {
      if (!stopped && next.state !== "opening") setStatus(next);
    });
    const poll = () => {
      void api
        .getLibraryStatus()
        .then((next) => {
          if (stopped) return;
          if (next.state === "opening") timer = window.setTimeout(poll, 250);
          else setStatus(next);
        })
        .catch(() => {
          if (!stopped) timer = window.setTimeout(poll, 1000);
        });
    };
    poll();
    const slowTimer = window.setTimeout(() => setSlow(true), 300);
    return () => {
      stopped = true;
      off();
      window.clearTimeout(timer);
      window.clearTimeout(slowTimer);
      setSlow(false);
    };
  }, [status.state]);

  if (status.state === "ready") return <>{children}</>;
  return (
    <div className="flex h-full flex-col bg-bg text-ink">
      <WindowBar />
      <main className="flex flex-1 items-center justify-center overflow-y-auto p-6">
        {status.state === "failed" ? (
          <LibraryFailure
            failure={status}
            onRetry={() => {
              setStatus({ state: "opening" });
              void api.retryLibrary().catch(() => {});
            }}
            onRestore={() => setRestoring(true)}
          />
        ) : (
          slow && (
            <p role="status" className="text-sm text-muted">
              {t("gate.opening")}
            </p>
          )
        )}
      </main>
      {restoring && (
        <BackupRestoreDialog
          onRestored={() => {
            restored.current = true;
          }}
          onClose={() => {
            setRestoring(false);
            // The app opens the restored library already; follow it.
            if (restored.current) setStatus({ state: "opening" });
          }}
        />
      )}
    </div>
  );
}

/** Plain text for support; labels stay English so anyone can read them. */
const report = (f: OpenFailure, language: string) =>
  [
    `Koona Pin ${f.version}`,
    `Code: ${f.code}`,
    `Detail: ${f.detail}`,
    `Library: ${f.database}`,
    f.backup && `Backup: ${f.backup}`,
    f.schema !== null && `Schema: ${f.schema} (supported ${f.supported})`,
    `Language: ${language}`,
  ]
    .filter(Boolean)
    .join("\n");

function LibraryFailure({ failure, onRetry, onRestore }: { failure: OpenFailure; onRetry: () => void; onRestore: () => void }) {
  const { t, i18n } = useTranslation();
  const [note, setNote] = useState("");
  const retry = !final.includes(failure.code);
  const place = failure.code === "MIGRATION_FAILED" ? "backup" : "data";
  const text = report(failure, i18n.language);
  const file = failure.database.split(/[\\/]/).pop();
  return (
    <section
      role="alert"
      aria-labelledby="library-failure-title"
      data-error-code={failure.code}
      className="flex max-w-[480px] flex-col items-center gap-2.5 text-center text-muted"
    >
      <span className="mb-1.5 flex size-12 items-center justify-center rounded-full bg-danger-soft text-danger">
        <Icon icon={CircleAlert} size={20} />
      </span>
      <h1 id="library-failure-title" className="text-lg font-semibold text-ink">
        {t(`gate.${failure.code}.title`)}
      </h1>
      <p className="text-sm [overflow-wrap:anywhere]">
        {t(`gate.${failure.code}.body`, {
          schema: failure.schema,
          supported: failure.supported,
          detail: failure.detail,
          backupNote: failure.backup ? t("gate.MIGRATION_FAILED.backupNote", { backup: failure.backup }) : "",
        })}
      </p>
      <p className="text-xs">
        {file} · {failure.code}
      </p>
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        {retry && (
          <Button variant="primary" autoFocus onClick={onRetry}>
            {t("common.retry")}
          </Button>
        )}
        {/* A phone has no file manager, and its app is not quit from a button (NP-151). */}
        {capabilities.file_manager && (
          <Button
            autoFocus={!retry}
            onClick={() => void api.revealLibraryPlace(place).catch((err) => setNote(describeError(err)))}
          >
            {place === "backup" ? t("gate.openBackup") : t("gate.openData")}
          </Button>
        )}
        <Button
          onClick={() => {
            navigator.clipboard
              .writeText(text)
              .then(() => setNote(t("gate.reportCopied")))
              .catch(() => setNote(t("gate.reportFailed")));
          }}
        >
          {t("gate.copyReport")}
        </Button>
        {capabilities.quit && (
          <Button variant="ghost" onClick={() => void api.quitApp().catch(() => {})}>
            {t("gate.quit")}
          </Button>
        )}
      </div>
      {replaceable.includes(failure.code) && (
        <button type="button" onClick={onRestore} className="mt-1 text-xs font-medium text-accent hover:underline">
          {t("gate.restore")}
        </button>
      )}
      {note && (
        <p role="status" className="text-xs">
          {note}
        </p>
      )}
      <details className="self-stretch text-left text-2xs">
        <summary className="text-center">{t("gate.details")}</summary>
        <pre className="mt-2 rounded-lg bg-panel px-3 py-2.5 whitespace-pre-wrap select-text [overflow-wrap:anywhere]">{text}</pre>
      </details>
    </section>
  );
}
