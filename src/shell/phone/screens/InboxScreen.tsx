import { usePhone } from "../PhoneContext";
import { Progress } from "../ui/Progress";
import { Screen, Header } from "../ui/Screen";

/** I1–I3, E1 Inbox and triage (stub, NP-072b wave 0; wave 1 replaces it). */
export function InboxScreen({ hidden }: { hidden: boolean }) {
  const { app } = usePhone();
  const { t } = app;
  return (
    <Screen label={t("phone.inbox.title")} hidden={hidden}>
      <Header title={t("phone.inbox.title")} meta={t("phone.library.count", { count: app.counts.inbox })}>
        <Progress done={0} total={app.counts.inbox} label={false} className="mt-3" />
      </Header>
      <p className="ph-stub">{t("phone.stub")}</p>
    </Screen>
  );
}
