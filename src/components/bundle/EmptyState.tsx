import { forwardRef } from "react";
import { Layers, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Icon } from "../icons";
import { Button } from "../ui/Button";

/**
 * The empty bundle (K7b): a tilted card, what the bundle is for, and «Add {view} · N» as its one
 * button, while the view on screen can be added.
 */
export const EmptyState = forwardRef<HTMLButtonElement, { add: { label: string; onAdd: () => void } | null }>(function EmptyState({ add }, ref) {
  const { t } = useTranslation();
  return (
    <div data-bundle-empty className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-8 text-center">
      <span aria-hidden className="mb-2 flex size-16 items-center justify-center rounded-full bg-accent-soft text-accent">
        <span className="flex h-8 w-6 rotate-[-8deg] items-center justify-center rounded-md border-[1.5px] border-current">
          <Icon icon={Layers} size={12} />
        </span>
      </span>
      <p className="text-md font-semibold text-ink">{t("bundle.emptyTitle")}</p>
      <p className="text-sm text-muted">{t("bundle.emptyHint")}</p>
      {add && (
        <Button ref={ref} variant="outline" size="lg" onClick={add.onAdd} className="mt-2 text-ink">
          <Icon icon={Plus} size={15} />
          {add.label}
        </Button>
      )}
    </div>
  );
});
