import { ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Icon } from "../icons";
import { IconButton } from "./Button";
import { Kbd } from "./Hint";

/**
 * A modal dialog or, with `drawer`, the editor over the content in a narrow
 * window. Escape and a click on the backdrop close it; focus returns to the
 * element that opened it. The content mounts only once the dialog is open, so
 * `autoFocus` inside it works: on a hidden dialog React's focus is lost, and
 * showModal() would then pick the first control — «×».
 */
export function Dialog({
  title,
  onClose,
  children,
  drawer = false,
  width = 440,
  locked = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  drawer?: boolean;
  width?: number;
  /** While work that cannot stop runs: Escape, the backdrop and «×» do nothing (frame 28). */
  locked?: boolean;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = locked ? () => {} : onClose;
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.showModal();
    setOpen(true);
    return () => {
      dialog?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      data-drawer={drawer || undefined}
      style={drawer ? undefined : { width }}
      className={
        drawer
          ? "fixed inset-y-0 right-0 left-auto m-0 h-full max-h-full w-[380px] max-w-full animate-appear border-l border-border bg-card p-0 text-ink shadow-menu"
          : "m-auto max-w-[calc(100vw-32px)] animate-appear flex-col rounded-2xl border border-border bg-card p-0 text-ink shadow-menu open:flex"
      }
      onCancel={(e) => {
        e.preventDefault();
        closeRef.current();
      }}
      onClick={(e) => {
        // Only the backdrop: the padding belongs to the inner block.
        if (e.target === ref.current) closeRef.current();
      }}
    >
      {open && (
        // A column: the states of a dialog (StatePanels) give way to a low window, the rest scrolls.
        <div className={drawer ? "min-h-full p-6" : "flex min-h-0 flex-col p-5"}>
          <header className="mb-4 flex items-center justify-between gap-3">
            <h2 id={titleId} className="text-lg font-semibold">
              {title}
            </h2>
            <span className="flex items-center gap-1.5">
              <IconButton label={t("common.close")} onClick={onClose} disabled={locked}>
                <Icon icon={X} />
              </IconButton>
              {drawer && (
                <span aria-hidden>
                  <Kbd>Esc</Kbd>
                </span>
              )}
            </span>
          </header>
          {children}
        </div>
      )}
    </dialog>
  );
}
