import { ReactNode, useEffect, useState } from "react";
import { CircleAlert } from "lucide-react";
import { api, isTauri } from "../services/api";
import { LibraryStatus, OpenFailure } from "../types";
import { WindowBar } from "./ui/WindowBar";
import { describeError } from "../services/errors";
import { applyTheme, isDark, storedTheme } from "../services/preferences";
import {
  failureReport,
  failureText,
  libraryLabels,
} from "../services/libraryMessages";

const ready: LibraryStatus = { state: "ready", damaged: false, moved_aside: null };

/**
 * Shows the library only once it has opened. Until then: nothing for the
 * first 300 ms, then "Opening…"; when opening fails, the screen of frame
 * «12 · Ошибки» instead of the library. Database commands are not called
 * before the library is ready.
 */
export function LibraryGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<LibraryStatus>(
    isTauri() ? { state: "opening" } : ready,
  );
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    applyTheme(
      isDark(storedTheme(), matchMedia("(prefers-color-scheme:dark)").matches),
    );
  }, []);
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
  const labels = libraryLabels();
  return (
    <div className="study-root study-editorial production">
      <div className="study-window">
        <WindowBar />
        <main className="library-gate">
          {status.state === "failed" ? (
            <LibraryFailure
              failure={status}
              onRetry={() => {
                setStatus({ state: "opening" });
                void api.retryLibrary().catch(() => {});
              }}
            />
          ) : (
            slow && (
              <p className="study-loading" role="status">
                {labels.opening}
              </p>
            )
          )}
        </main>
      </div>
    </div>
  );
}

function LibraryFailure({
  failure,
  onRetry,
}: {
  failure: OpenFailure;
  onRetry: () => void;
}) {
  const text = failureText(failure);
  const labels = libraryLabels();
  const report = failureReport(failure);
  const [note, setNote] = useState("");
  const file = failure.database.split(/[\\/]/).pop();
  const reveal = () => {
    void api.revealLibraryPlace(text.place).catch((err) => setNote(describeError(err)));
  };
  return (
    <section
      className="library-failure"
      role="alert"
      aria-labelledby="library-failure-title"
      data-error-code={failure.code}
    >
      <span className="library-failure-icon">
        <CircleAlert size={20} />
      </span>
      <h1 id="library-failure-title">{text.title}</h1>
      <p>{text.body(failure)}</p>
      <p className="library-failure-code">
        {file} · {failure.code}
      </p>
      <div className="library-failure-actions">
        {text.retry && (
          <button className="study-button primary" autoFocus onClick={onRetry}>
            {labels.retry}
          </button>
        )}
        <button className="study-button" autoFocus={!text.retry} onClick={reveal}>
          {text.place === "backup" ? labels.backup : labels.data}
        </button>
        <button
          className="study-button"
          onClick={() => {
            navigator.clipboard
              .writeText(report)
              .then(() => setNote(labels.copied))
              .catch(() => setNote(labels.copyFailed));
          }}
        >
          {labels.report}
        </button>
        <button
          className="study-button quiet"
          onClick={() => void api.quitApp().catch(() => {})}
        >
          {labels.quit}
        </button>
      </div>
      {note && (
        <p className="library-failure-note" role="status">
          {note}
        </p>
      )}
      <details className="library-failure-details">
        <summary>{labels.details}</summary>
        <pre>{report}</pre>
      </details>
    </section>
  );
}
