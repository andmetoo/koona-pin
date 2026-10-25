import type { CSSProperties } from "react";
import { ArrowRight, BookOpen, Check, Folder, Plus, Share, Trash2, Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Mascot } from "../../../components/icons";
import { collectionTint } from "../../../services/collections";
import type { Collection } from "../../../types";
import { Button } from "../ui/buttons";
import { PhIcon } from "../ui/icons";
import { Shelf, ShelfRow } from "../ui/Shelf";
import type { summary } from "./triage";

/**
 * I3, the inbox sorted: a check on an accent-soft disc, "Inbox sorted", how many decisions in how
 * long, the summary shelf (kept, filed into collections with their dots, added to Reading, moved
 * to the trash "Kept there for 30 days"), "Go to library" and "Undo last decision".
 */
export function InboxSorted({
  sum,
  collections,
  minutes,
  onLibrary,
  onUndo,
}: {
  sum: ReturnType<typeof summary>;
  /** The library's, for the colours of the ones filed into (a collection's own colour since 2.19.0). */
  collections: Collection[];
  minutes: number;
  onLibrary: () => void;
  onUndo: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="inb-state inb-sorted" data-inbox-sorted>
      <span className="inb-done-mark" aria-hidden="true">
        <Check size={34} strokeWidth={2} absoluteStrokeWidth />
      </span>
      <h2 className="ph-title1">{t("triage.done")}</h2>
      <p className="ph-meta inb-state-line">{t("phone.inbox.decisions", { count: sum.count, minutes: t("phone.inbox.minutes", { count: minutes }) })}</p>
      <Shelf className="inb-summary">
        <ShelfRow icon={Check} title={t("phone.inbox.statKept")} detail={sum.kept} className="inb-stat inb-stat-kept" />
        <ShelfRow
          icon={Folder}
          title={t("phone.inbox.statFiled")}
          detail={
            <>
              <span className="inb-dots" aria-hidden="true">
                {sum.filedInto.slice(0, 3).map((id) => (
                  <span key={id} className="ph-chip-dot" style={{ "--dot": collectionTint(collections.find((c) => c.id === id) ?? { id, color: null }) } as CSSProperties} />
                ))}
              </span>
              {sum.filed}
            </>
          }
          className="inb-stat"
        />
        <ShelfRow icon={BookOpen} title={t("phone.inbox.statReading")} detail={sum.reading} className="inb-stat" />
        <ShelfRow icon={Trash2} title={t("phone.inbox.statTrashed")} subtitle={t("phone.inbox.trashKept")} detail={sum.trashed} className="inb-stat" />
      </Shelf>
      <p className="ph-meta inb-state-line">{t("phone.inbox.newWait")}</p>
      <div className="inb-state-actions">
        <Button kind="primary" block onClick={onLibrary}>
          {t("phone.inbox.toLibrary")}
          <PhIcon icon={ArrowRight} />
        </Button>
        {sum.count > 0 && (
          <Button kind="ghost" block icon={Undo2} onClick={onUndo} className="inb-undo">
            {t("triage.undoLast")}
          </Button>
        )}
      </div>
    </section>
  );
}

/**
 * E1, nothing waits: three cards with the Pin Spirit on the front one, "All sorted", a tip for
 * getting links in — sharing from other apps where the phone can take a share, else "+" — and
 * "Open library" with "New link".
 */
export function InboxEmpty({ shareIntake, onLibrary, onNew }: { shareIntake: boolean; onLibrary: () => void; onNew: () => void }) {
  const { t } = useTranslation();
  return (
    <section className="inb-state inb-empty" data-inbox-empty>
      <div className="inb-art" aria-hidden="true">
        <span className="inb-art-glow" />
        <span className="inb-art-card" data-at="left">
          <span className="inb-art-cover" />
          <span className="inb-art-line" />
          <span className="inb-art-line" data-short />
        </span>
        <span className="inb-art-card" data-at="right">
          <span className="inb-art-cover" />
          <span className="inb-art-line" />
          <span className="inb-art-line" data-short />
        </span>
        <span className="inb-art-card" data-at="front">
          <Mascot size={60} className="inb-art-mark" />
          <span className="inb-art-line" data-short />
        </span>
      </div>
      <h2 className="ph-title1">{t("phone.inbox.allSorted")}</h2>
      <p className="inb-empty-text">{t(shareIntake ? "phone.inbox.emptyShare" : "phone.inbox.emptyAdd")}</p>
      <div className="inb-tip">
        <span className="inb-tip-icon">
          <PhIcon icon={shareIntake ? Share : Plus} />
        </span>
        <span className="ph-shelf-text">
          <span className="inb-tip-title">{t(shareIntake ? "phone.inbox.tipShare" : "phone.inbox.tipAdd")}</span>
          <span className="ph-meta">{t(shareIntake ? "phone.inbox.tipShareHow" : "phone.inbox.tipAddHow")}</span>
        </span>
      </div>
      <div className="inb-empty-actions">
        <Button kind="clear" onClick={onLibrary}>
          {t("phone.inbox.openLibrary")}
        </Button>
        <Button kind="ink" icon={Plus} onClick={onNew}>
          {t("phone.nav.new")}
        </Button>
      </div>
    </section>
  );
}
