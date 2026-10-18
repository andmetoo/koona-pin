import { type CSSProperties, useState } from "react";
import { collectionColor } from "../../../services/collections";
import { usePhone } from "../PhoneContext";
import { Button } from "../ui/buttons";
import { Checkbox } from "../ui/controls";
import { Sheet, useCloseSheet } from "../ui/Sheet";
import { Shelf, ShelfRow } from "../ui/Shelf";

export type CollectionPickerProps = { bookmarkIds: number[] };

/** C1 Collection picker (stub, NP-072b wave 0; wave 1 replaces it): a detached sheet. */
export function CollectionPicker({ props }: { props: CollectionPickerProps }) {
  const { app } = usePhone();
  const { t } = app;
  const close = useCloseSheet();
  const [chosen, setChosen] = useState<number | null>(null);
  return (
    <Sheet
      label={t("phone.collectionPicker.title")}
      title={t("phone.collectionPicker.title")}
      subtitle={t("phone.library.count", { count: props.bookmarkIds.length })}
      footer={
        <Button kind="primary" block onClick={close}>
          {t("phone.collectionPicker.done")}
        </Button>
      }
    >
      <Shelf className="-mx-4">
        {app.library.collections.map((c) => (
          <ShelfRow
            key={c.id}
            title={
              <span className="flex items-center gap-3">
                <span className="ph-chip-dot" style={{ "--dot": collectionColor(c.id) } as CSSProperties} />
                {c.name}
              </span>
            }
            trailing={<Checkbox checked={chosen === c.id} label={c.name} onChange={(on) => setChosen(on ? c.id : null)} />}
          />
        ))}
      </Shelf>
    </Sheet>
  );
}
