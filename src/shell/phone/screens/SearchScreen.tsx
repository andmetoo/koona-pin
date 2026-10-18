import { useState } from "react";
import { usePhone } from "../PhoneContext";
import { SearchField } from "../ui/controls";
import { Screen, Header } from "../ui/Screen";

/** Q1 Search (stub, NP-072b wave 0; wave 1 replaces it): the nav pill hides on it. */
export function SearchScreen({ hidden }: { hidden: boolean }) {
  const { app, stack } = usePhone();
  const { t } = app;
  const [query, setQuery] = useState("");
  return (
    <Screen label={t("phone.search.title")} hidden={hidden} route>
      <Header title={t("phone.search.title")} account={false} onBack={stack.back}>
        <SearchField className="mt-3" value={query} onChange={setQuery} placeholder={t("phone.library.search", { count: app.counts.total })} />
      </Header>
      <p className="ph-stub">{t("phone.stub")}</p>
    </Screen>
  );
}
