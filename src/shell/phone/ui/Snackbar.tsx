import { useEffect, useRef } from "react";
import { Check, CircleAlert, type LucideIcon } from "lucide-react";
import { glass } from "./Glass";
import { PhIcon } from "./icons";

export const SNACKBAR_MS = 5000;

/**
 * The snackbar (doc/mobile-design.md): a toast-glass pill 48 tall above the nav pill (or the
 * decision pill), a mint icon, the message, a hairline and the action in mint (Undo). It goes by
 * itself after 5 s — not an `alert`, which stays until closed — and waits while a finger is on it.
 * Swiping or tapping it is not a dismissal: the action or the time is.
 */
export function Snackbar({
  text,
  alert = false,
  icon,
  action,
  onTimeout,
  duration = SNACKBAR_MS,
}: {
  text: string;
  alert?: boolean;
  /** Check by default, alert sign for an alert; Trash after a move to the trash. */
  icon?: LucideIcon;
  action?: { label: string; run: () => void };
  /** The time is up. */
  onTimeout: () => void;
  duration?: number;
}) {
  const timeout = useRef(onTimeout);
  timeout.current = onTimeout;
  const timer = useRef<{ id: number | null; left: number; since: number }>({ id: null, left: duration, since: 0 });

  const start = () => {
    const t = timer.current;
    if (t.id !== null || alert) return;
    t.since = Date.now();
    t.id = window.setTimeout(() => timeout.current(), t.left);
  };
  const pause = () => {
    const t = timer.current;
    if (t.id === null) return;
    window.clearTimeout(t.id);
    t.id = null;
    t.left = Math.max(800, t.left - (Date.now() - t.since));
  };

  // A new message starts its own time.
  useEffect(() => {
    timer.current = { id: null, left: duration, since: 0 };
    start();
    return pause;
  }, [text, alert, duration]);

  return (
    <div
      role={alert ? "alert" : "status"}
      data-alert={alert || undefined}
      data-snackbar
      className={`ph-snackbar ${glass("toast")}`}
      onPointerDown={pause}
      onPointerUp={start}
      onPointerCancel={start}
      onPointerLeave={start}
    >
      <PhIcon icon={icon ?? (alert ? CircleAlert : Check)} at="field" className="ph-snackbar-icon" />
      <span className="ph-snackbar-text">{text}</span>
      {action && (
        <button type="button" className="ph-snackbar-action" onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  );
}
