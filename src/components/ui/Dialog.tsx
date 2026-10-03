import { ReactNode, useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Icon } from "../icons";
import { IconButton } from "./Button";
import { Kbd } from "./Hint";

/**
 * A modal dialog or, with `drawer`, the editor over the content in a narrow
 * window. Escape and a click on the backdrop close it; focus returns to the
 * element that opened it.
 */
export function Dialog({
  title,
  onClose,
  children,
  drawer = false,
  width = 440,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  drawer?: boolean;
  width?: number;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.showModal();
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
          : "m-auto max-w-[calc(100vw-32px)] animate-appear rounded-2xl border border-border bg-card p-0 text-ink shadow-menu"
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
      <div className={drawer ? "min-h-full p-6" : "p-5"}>
        <header className="mb-4 flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
          <span className="flex items-center gap-1.5">
            <IconButton label={t("common.close")} onClick={onClose}>
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
    </dialog>
  );
}
