import { Check } from "lucide-react";
import { usePhone } from "../PhoneContext";
import { Button } from "../ui/buttons";
import { Sheet, useCloseSheet } from "../ui/Sheet";

/** The reader's bookmark, and what finishing it does (the reader leaves Reading with Undo). */
export type FinishSheetProps = { onFinish: () => void };

/**
 * "Mark as finished?": a tap on the reading progress (the pie, iPhone Duo's drop) asks before the
 * bookmark leaves Reading; pulling it up does it at once.
 */
export function FinishSheet({ props }: { props: FinishSheetProps }) {
  const { app } = usePhone();
  const { t } = app;
  const close = useCloseSheet();
  return (
    <Sheet
      label={t("phone.reader.finishAsk")}
      title={t("phone.reader.finishAsk")}
      footer={
        <Button
          kind="primary"
          block
          icon={Check}
          onClick={() => {
            close();
            props.onFinish();
          }}
        >
          {t("phone.reader.finish")}
        </Button>
      }
    >
      <p className="ph-subhead rd-finish-text">{t("phone.reader.finishText")}</p>
    </Sheet>
  );
}
