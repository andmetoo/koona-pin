import type { Route } from "../navigation/stack";
import { usePhone } from "../PhoneContext";
import { Screen, Header } from "../ui/Screen";

/** A feed's post (stub, NP-072b wave 0; wave 1 replaces it), pushed over Feeds. */
export function PostScreen({ route, hidden }: { route: Extract<Route, { name: "post" }>; hidden: boolean }) {
  const { app, stack } = usePhone();
  const { t } = app;
  return (
    <Screen label={t("phone.post.title")} hidden={hidden} route>
      <Header title={t("phone.post.title")} account={false} onBack={stack.back} />
      <p className="ph-stub" data-post-id={route.itemId}>
        {t("phone.stub")}
      </p>
    </Screen>
  );
}
