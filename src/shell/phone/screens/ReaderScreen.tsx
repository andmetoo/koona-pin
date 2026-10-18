import { Ellipsis } from "lucide-react";
import type { Route } from "../navigation/stack";
import { usePhone } from "../PhoneContext";
import { CircleButton } from "../ui/buttons";
import { Screen, Header } from "../ui/Screen";

/** R1 Reader (stub, NP-072b wave 0; wave 1 replaces it): one bookmark, pushed over its tab. */
export function ReaderScreen({ route, hidden }: { route: Extract<Route, { name: "reader" }>; hidden: boolean }) {
  const { app, stack, sheets } = usePhone();
  const { t } = app;
  const bookmark = app.library.bookmarks.find((b) => b.id === route.bookmarkId);
  return (
    <Screen label={t("phone.reader.title")} hidden={hidden} route>
      <Header
        title={bookmark?.title || t("phone.reader.title")}
        meta={bookmark?.domain}
        account={false}
        onBack={stack.back}
        actions={
          <CircleButton
            icon={Ellipsis}
            label={t("phone.reader.more")}
            onClick={() => sheets.open({ kind: "bookmarkMenu", props: { bookmarkId: route.bookmarkId } })}
          />
        }
      />
      <p className="ph-stub">{t("phone.stub")}</p>
    </Screen>
  );
}
