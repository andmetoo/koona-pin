import { type ComponentType, useEffect, useMemo } from "react";
import { onBack } from "../../../platform/back";
import { SheetHandleContext } from "../ui/Sheet";
import { SHEETS } from "./registry";
import type { SheetEntry } from "./useSheets";

/** The one layer of sheets over the screens: each open sheet in its own host, the newest on top. */
export function SheetLayer({ entries, close, exited }: { entries: SheetEntry[]; close: (id: number) => void; exited: (id: number) => void }) {
  return (
    <>
      {entries.map((entry) => (
        <SheetHost key={entry.id} entry={entry} close={close} exited={exited} />
      ))}
    </>
  );
}

function SheetHost({ entry, close, exited }: { entry: SheetEntry; close: (id: number) => void; exited: (id: number) => void }) {
  const { id, place, leaving, kind } = entry;
  // Back closes it while it is open, at the place it took when it opened: above the stack and
  // what was open before it.
  useEffect(() => {
    if (leaving) return;
    return onBack(() => {
      close(id);
      return true;
    }, place);
  }, [id, place, leaving, close]);
  const handle = useMemo(() => ({ leaving, close: () => close(id), exited: () => exited(id) }), [leaving, id, close, exited]);
  const Component = SHEETS[kind] as ComponentType<{ props: unknown }>;
  return (
    <div className="ph-sheet-host" data-sheet-kind={kind} data-leaving={leaving || undefined}>
      <SheetHandleContext.Provider value={handle}>
        <Component props={entry.props} />
      </SheetHandleContext.Provider>
    </div>
  );
}
