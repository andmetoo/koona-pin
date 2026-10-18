import { usePhone } from "../PhoneContext";
import { Screen, Header } from "../ui/Screen";

/** F1 Feeds (stub, NP-072b wave 0; wave 1 replaces it). The app is on its Feeds page meanwhile. */
export function FeedsScreen({ hidden }: { hidden: boolean }) {
  const { app } = usePhone();
  const { t } = app;
  return (
    <Screen label={t("phone.feeds.title")} hidden={hidden}>
      <Header title={t("phone.feeds.title")} />
      <p className="ph-stub">{t("phone.stub")}</p>
    </Screen>
  );
}
