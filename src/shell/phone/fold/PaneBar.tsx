import type { ReactNode } from "react";

/**
 * The top of the Fold's detail sheet (FL1, FL2): its secondary round actions, clear circles 44 that
 * stay while the content scrolls under the sheet's top fade. `outer` sits on the screen's edge side
 * (more, Aa), `near` next to the list; the left hand mirrors the order (`data-hand`, fold.css).
 */
export function PaneBar({ outer, near }: { outer?: ReactNode; near?: ReactNode }) {
  return (
    <div className="ph-panebar">
      <div className="ph-panebar-group">{outer}</div>
      <div className="ph-panebar-group">{near}</div>
    </div>
  );
}
