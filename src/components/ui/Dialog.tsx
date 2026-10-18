import { ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Icon } from "../icons";
import { IconButton } from "./Button";
import { Kbd } from "./Hint";
import { useBack } from "../../hooks/useBack";

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
  badge,
  height,
  caption,
  eyebrow = false,
  back = true,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  drawer?: boolean;
  width?: number;
  /** While work that cannot stop runs: Escape, the backdrop and «×» do nothing (frame 28). */
  locked?: boolean;
  /** Next to the title: «Test payments» of the Supporter dialog (sheet 45). */
  badge?: ReactNode;
  /** A fixed height, such as `min(640px, calc(100vh - 48px))`: the body fills it (K1, K2). */
  height?: string;
  /** A small capitalised line above the title (K2: «Share as list»). */
  caption?: string;
  /** The title as a small capitals label over the body's own heading (K1: «IMPORT LIST»). */
  eyebrow?: boolean;
  /** A phone's Back closes it (NP-151); off where the owner handles Back itself (the editor). */
  back?: boolean;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = locked ? () => {} : onClose;
  // A phone's Back closes it as Escape does (NP-151).
  useBack(() => closeRef.current(), back);
  const [open, setOpen] = useState(false);
  const heading = (
    <h2 id={titleId} className={eyebrow ? "text-2xs font-semibold tracking-[0.06em] text-muted uppercase" : "text-lg font-semibold"}>
      {title}
    </h2>
  );
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
      style={drawer ? undefined : { width, height }}
      className={
        drawer
          ? "fixed inset-y-0 right-0 left-auto m-0 h-full max-h-full w-[380px] max-w-full animate-appear border-l border-border bg-card p-0 text-ink shadow-menu"
          : "app-dialog m-auto max-w-[calc(100vw-32px)] flex-col p-0 text-ink open:flex"
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
        <div className={drawer ? "min-h-full p-6" : `flex min-h-0 flex-col p-5 ${height ? "flex-1" : ""}`}>
          <header className="mb-4 flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2">
              {caption ? (
                <span className="flex min-w-0 flex-col">
                  <span className="text-2xs font-semibold tracking-wide text-subtle uppercase">{caption}</span>
                  {heading}
                </span>
              ) : (
                heading
              )}
              {badge}
            </span>
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
