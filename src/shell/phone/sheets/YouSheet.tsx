import { CloudCheck } from "../ui/icons";
import { Heart, Settings } from "lucide-react";
import { usePhone } from "../PhoneContext";
import { Sheet, useCloseSheet } from "../ui/Sheet";
import { Shelf, ShelfRow } from "../ui/Shelf";

export type YouSheetProps = Record<string, never>;

/**
 * A1 "You & sync" (stub, NP-072b wave 0; wave 1 replaces it): the account cluster opens it. The
 * Supporter and sync rows open the shared dialogs; Settings pushes the settings route.
 */
export function YouSheet(_: { props: YouSheetProps }) {
  const { app, stack } = usePhone();
  const { t, supporter, sync, setSurface } = app;
  const close = useCloseSheet();
  return (
    <Sheet label={t("phone.you.title")} title={t("phone.you.title")}>
      <Shelf className="-mx-4">
        {supporter?.available && (
          <ShelfRow
            icon={Heart}
            title={supporter.plan ? t("phone.you.supporter") : t("phone.you.support")}
            chevron
            onClick={() => setSurface(supporter.plan ? "plan" : "supporter")}
          />
        )}
        {sync && <ShelfRow icon={CloudCheck} title={t("phone.you.sync")} chevron onClick={() => setSurface("sync")} />}
        <ShelfRow
          icon={Settings}
          title={t("phone.you.settings")}
          chevron
          onClick={() => {
            close();
            stack.push({ name: "settings" });
          }}
        />
      </Shelf>
    </Sheet>
  );
}
