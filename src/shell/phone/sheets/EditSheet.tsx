import { useState } from "react";
import { usePhone } from "../PhoneContext";
import { Button } from "../ui/buttons";
import { Field } from "../ui/controls";
import { Sheet, SheetBar, useCloseSheet } from "../ui/Sheet";

/** No props: the bookmark is `app.editing`; the shell opens this sheet when it is set. */
export type EditSheetProps = Record<string, never>;

/**
 * B1 Edit bookmark (stub, NP-072b wave 0; wave 1 replaces it): the attached full-height sheet with
 * Cancel · Edit link · Save in its top bar. Open it with `app.setEditing(bookmark)`; closing it
 * closes the editor (useEditorSheet).
 */
export function EditSheet(_: { props: EditSheetProps }) {
  const { app } = usePhone();
  const { t } = app;
  const close = useCloseSheet();
  const [title, setTitle] = useState(app.editing?.title ?? "");
  return (
    <Sheet
      variant="attached"
      label={t("phone.edit.title")}
      bar={
        <SheetBar
          left={
            <Button compact onClick={close}>
              {t("common.cancel")}
            </Button>
          }
          title={t("phone.edit.title")}
          right={
            <Button compact kind="primary" onClick={close}>
              {t("phone.edit.save")}
            </Button>
          }
        />
      }
    >
      <Field label={t("phone.edit.titleField")} value={title} onChange={setTitle} />
      <p className="ph-meta mt-4">{t("phone.stub")}</p>
    </Sheet>
  );
}
