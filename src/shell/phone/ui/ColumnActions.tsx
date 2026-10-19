import { type ReactNode, useEffect, useId, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { usePhone } from "../PhoneContext";

// Who holds the column's action slots now: the lowest rank, the first of equals.
const claims = new Map<string, number>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
function holder(): string | null {
  let best: string | null = null;
  let bestRank = Infinity;
  for (const [id, rank] of claims)
    if (rank < bestRank) {
      best = id;
      bestRank = rank;
    }
  return best;
}

/**
 * Secondary round actions that move into the iPhone Duo's vertical bar (iOS 27.1): 38 pt circles
 * in UIKit's toolbar slots under the status block (frames DU1, DU2). One screen holds the slots at a
 * time, the lowest `rank` (the list pane's own actions, 1, before the detail's, 2); the others stay
 * where they are. Without a vertical bar, or while `active` is false (the screen is hidden), the
 * children render in place, as on any other phone.
 */
export function ColumnActions({ rank, active = true, children }: { rank: number; active?: boolean; children: ReactNode }) {
  const { bar, column } = usePhone();
  const id = useId();
  const claiming = Boolean(bar && column) && active;
  useEffect(() => {
    if (!claiming) return;
    claims.set(id, rank);
    notify();
    return () => {
      claims.delete(id);
      notify();
    };
  }, [id, rank, claiming]);
  const held = useSyncExternalStore(subscribe, holder, holder);
  if (claiming && column && held === id) return createPortal(children, column);
  return <>{children}</>;
}
