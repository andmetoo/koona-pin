import { usePhone } from "../PhoneContext";
import { Sheet } from "../ui/Sheet";

/** `url`: a link to start from (a pasted or shared one). */
export type NewLinkSheetProps = { url?: string };

/** N1 New link (stub, NP-072b wave 0; wave 1 replaces it): "+" in the nav pill opens it. */
export function NewLinkSheet(_: { props: NewLinkSheetProps }) {
  const { app } = usePhone();
  const { t } = app;
  return (
    <Sheet label={t("phone.newLink.title")} title={t("phone.newLink.title")}>
      <p className="ph-meta">{t("phone.stub")}</p>
    </Sheet>
  );
}
