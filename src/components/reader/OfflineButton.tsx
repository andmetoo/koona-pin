import { useEffect, useRef, useState } from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Bookmark, OfflineCopy } from "../../types";
import { Article } from "../../services/reader";
import { OfflineIcon } from "../icons";
import { Button } from "../ui/Button";
import { Hint } from "../ui/Hint";
import { Menu } from "../ui/Menu";

/**
 * Offline copies saved or removed in a reader (NP-126): its button says so at
 * once, before the list is read again with them (`reset` — the list — clears
 * what it knows). Saving with no article reads the page now («Update copy»);
 * then `onUpdated` shows the new copy.
 */
export function useOfflineCopies({
  onSave,
  onRemove,
  reset,
  onUpdated,
}: {
  onSave: (bookmark: Bookmark, article?: Article, quiet?: boolean) => Promise<OfflineCopy | null>;
  onRemove: (bookmark: Bookmark) => Promise<boolean>;
  reset: unknown;
  onUpdated: () => void;
}) {
  const [copies, setCopies] = useState<Map<number, string | null>>(() => new Map());
  const [saving, setSaving] = useState<number | null>(null);
  useEffect(() => setCopies(new Map()), [reset]);
  const keep = (b: Bookmark, at: string | null) => setCopies((known) => new Map(known).set(b.id, at));
  return {
    /** When the bookmark's copy was saved; none without one. */
    offlineAt: (b: Bookmark) => (copies.has(b.id) ? copies.get(b.id)! : b.offline_at),
    /** The bookmark whose copy is being saved. */
    saving,
    save: async (b: Bookmark, article?: Article, quiet = false) => {
      setSaving(b.id);
      const copy = await onSave(b, article, quiet);
      setSaving(null);
      if (!copy) return;
      keep(b, copy.saved_at);
      if (!article) onUpdated();
    },
    remove: async (b: Bookmark) => {
      if (await onRemove(b)) keep(b, null);
    },
  };
}

/**
 * «Save offline» of the reader's bar, left of «Aa» (NP-126, frame O3): an
 * outline button that keeps the article on screen on this computer. Saved
 * (frame O4), it reads «Saved offline» in the ordinary button colour a shade
 * off the page — the pressed «Read» beside it, not the accent — and opens a
 * small menu: «Update copy» reads the page again, «Remove copy» deletes it.
 * In a narrow window the icon alone with its hint.
 */
export function OfflineButton({
  saved,
  busy,
  narrow,
  disabled,
  onSave,
  onUpdate,
  onRemove,
  className = "",
}: {
  saved: boolean;
  /** A save or an update under way: the button waits. */
  busy: boolean;
  narrow: boolean;
  /** No article to save yet (loading, or none could be read). */
  disabled: boolean;
  onSave: () => void;
  onUpdate: () => void;
  onRemove: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const button = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const label = busy ? t("offline.saving") : saved ? t("offline.saved") : t("offline.save");
  return (
    <>
      <Hint label={label} show={narrow}>
        <Button
          ref={button}
          variant="outline"
          size="lg"
          data-offline-button={saved ? "saved" : "save"}
          aria-label={narrow ? label : undefined}
          aria-haspopup={saved ? "menu" : undefined}
          aria-expanded={saved ? !!menu : undefined}
          aria-busy={busy || undefined}
          disabled={busy || (!saved && disabled)}
          onClick={() => (saved ? setMenu(menu ? null : button.current!.getBoundingClientRect()) : onSave())}
          className={`rounded-lg text-read-text ${saved ? "bg-read-track" : ""} ${narrow ? "w-[34px] !px-0" : ""} ${className}`}
        >
          <OfflineIcon filled={saved} size={15} cut="[&_path]:stroke-read-track" className="shrink-0" />
          {!narrow && label}
        </Button>
      </Hint>
      {menu && (
        <Menu
          label={t("offline.saved")}
          anchor={menu}
          width={200}
          trigger={button.current}
          onClose={() => setMenu(null)}
          entries={[
            { id: "offline-update", icon: RefreshCw, label: t("offline.update"), onSelect: onUpdate },
            { id: "offline-remove", icon: Trash2, label: t("offline.remove"), onSelect: onRemove },
          ]}
        />
      )}
    </>
  );
}
