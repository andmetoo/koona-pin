import type { Route } from "../navigation/stack";
import { usePhone } from "../PhoneContext";
import { Screen, Header } from "../ui/Screen";

/**
 * Settings (stub, NP-072b wave 0; wave 1 replaces it): the list, or the sub-page `route.page`
 * pushed over it as another settings route.
 */
export function SettingsScreen({ route, hidden }: { route: Extract<Route, { name: "settings" }>; hidden: boolean }) {
  const { app, stack } = usePhone();
  const { t } = app;
  return (
    <Screen label={t("phone.settings.title")} hidden={hidden} route>
      <Header title={t("phone.settings.title")} meta={route.page} account={false} onBack={stack.back} />
      <p className="ph-stub">{t("phone.stub")}</p>
    </Screen>
  );
}
