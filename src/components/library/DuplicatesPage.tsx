import { useCallback, useEffect, useRef, useState } from "react";
import { Star } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Bookmark, Collection, DuplicateGroup, MergeGroup, Merged } from "../../types";
import { api } from "../../services/api";
import { collectionColor } from "../../services/collections";
import { mergedFields } from "../../services/duplicates";
import { CommandError, describeError } from "../../services/errors";
import { Icon } from "../icons";
import { Button } from "../ui/Button";
import { Dot } from "../ui/Controls";
import { Preview } from "./Bookmarks";
import { ConfirmDialog } from "./Dialogs";

/**
 * The section «Дубликаты» (NP-035, sheet 34): groups of the same page, the
 * main bookmark of each, what merging will keep, «Не дубликаты» and
 * «Объединить все». Merging is one journal command: the caller's notice
 * offers `Ctrl Z`.
 */
export function DuplicatesPage({
  collections,
  padding,
  onMerged,
  onHidden,
  onFailed,
}: {
  collections: Collection[];
  padding: string;
  onMerged: (merged: Merged) => void;
  onHidden: (key: string, ids: number[]) => void;
  onFailed: (text: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  /** The main bookmark chosen in each group; the default comes from the app. */
  const [mains, setMains] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const timer = useRef(0);

  const load = useCallback(() => {
    void api
      .getDuplicates()
      .then(setGroups)
      .catch((err) => {
        setGroups((prev) => prev ?? []);
        onFailed(describeError(err));
      });
  }, [onFailed]);
  useEffect(() => {
    load();
    // Any change of the library can make or break a group.
    const later = () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(load, 150);
    };
    const offs = [api.onBookmarkChanged(later), api.onBookmarksChanged(later), api.onLibraryInvalidated(later)];
    return () => {
      window.clearTimeout(timer.current);
      offs.forEach((off) => off());
    };
  }, [load]);

  const mainOf = (g: DuplicateGroup) => (g.bookmarks.some((b) => b.id === mains[g.key]) ? mains[g.key] : g.main);
  const planOf = (g: DuplicateGroup): MergeGroup => {
    const main = mainOf(g);
    return { main, others: g.bookmarks.filter((b) => b.id !== main).map((b) => b.id) };
  };
  const merge = async (plan: MergeGroup[]) => {
    setBusy(true);
    try {
      onMerged(await api.mergeDuplicates(plan));
    } catch (err) {
      // A bookmark changed meanwhile: show the groups as they are now.
      onFailed(err instanceof CommandError && err.code === "not_found" ? t("duplicates.changed") : t("duplicates.failed", { reason: describeError(err) }));
    } finally {
      setBusy(false);
      load();
    }
  };
  const hide = async (g: DuplicateGroup) => {
    const ids = g.bookmarks.map((b) => b.id);
    try {
      await api.dismissDuplicates(g.key, ids);
      onHidden(g.key, ids);
    } catch (err) {
      onFailed(describeError(err));
    }
    load();
  };

  const saved = (iso: string) => {
    const date = new Date(iso);
    const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((day(new Date()) - day(date)) / 86_400_000);
    if (days === 0) return t("duplicates.savedToday");
    if (days === 1) return t("duplicates.savedYesterday");
    return t("duplicates.savedOn", { date: shortDate(date, i18n.language) });
  };
  const collectionName = (id: number | null) => collections.find((c) => c.id === id)?.name ?? null;
  const after = (g: DuplicateGroup) => {
    const main = g.bookmarks.find((b) => b.id === mainOf(g))!;
    const others = g.bookmarks.filter((b) => b !== main);
    const fields = mergedFields(main, others);
    const notes = fields.notes ? fields.notes.split("\n\n").length : 0;
    const parts = [
      fields.tags?.length ? t("duplicates.afterTags", { tags: fields.tags.join(", ") }) : null,
      notes ? t("duplicates.afterNotes", { count: notes }) : null,
      fields.is_favorite ? "★" : null,
      collectionName(fields.collection_id),
      t("duplicates.afterSaved", { date: shortDate(new Date(fields.created_at), i18n.language) }),
      t("duplicates.afterTrash", { count: others.length }),
    ].filter(Boolean);
    return t("duplicates.after", { parts: parts.join(" · ") });
  };

  const total = groups?.reduce((sum, g) => sum + g.bookmarks.length, 0) ?? 0;
  return (
    <>
      <div className={`${padding} pt-2 pb-4`}>
        <h1 className="flex h-9 items-baseline gap-2 pt-1.5">
          <span className="text-2xl font-semibold">{t("duplicates.title")}</span>
          {groups && <span className="text-md text-subtle">{groups.length}</span>}
        </h1>
      </div>
      <div className={`min-h-0 flex-1 overflow-y-auto pb-8 ${padding}`}>
        {groups === null ? (
          <p role="status" className="text-sm text-muted">
            {t("duplicates.loading")}
          </p>
        ) : groups.length === 0 ? (
          <div className="flex flex-col items-center gap-2 pt-24 text-center">
            <h2 className="text-lg font-semibold">{t("duplicates.emptyTitle")}</h2>
            <p className="max-w-[400px] text-sm text-muted">{t("duplicates.emptyText")}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex min-h-9 items-center gap-3 rounded-lg bg-panel py-1 pr-1 pl-3 text-sm text-icon">
              <p className="min-w-0 flex-1">{t("duplicates.note")}</p>
              <Button variant="outline" disabled={busy} onClick={() => setConfirming(true)}>
                {t("duplicates.mergeAll")}
              </Button>
            </div>
            {groups.map((g) => (
              <section
                key={g.key}
                aria-labelledby={`dup-${g.key}`}
                data-duplicate-group={g.key}
                className="rounded-xl border border-line bg-card"
              >
                <header className="flex items-center gap-2 py-2 pr-4 pl-4">
                  <h2 id={`dup-${g.key}`} className="min-w-0 truncate text-sm font-semibold">
                    {g.key}
                  </h2>
                  <span className="shrink-0 text-sm text-subtle">{t("duplicates.bookmarks", { count: g.bookmarks.length })}</span>
                  <span className="flex-1" />
                  <Button variant="ghost" disabled={busy} onClick={() => void hide(g)}>
                    {t("duplicates.notDuplicates")}
                  </Button>
                  <Button variant="primary" disabled={busy} onClick={() => void merge([planOf(g)])}>
                    {busy ? t("duplicates.merging") : t("duplicates.merge")}
                  </Button>
                </header>
                <div role="radiogroup" aria-label={t("duplicates.mainOf", { key: g.key })} className="border-y border-divider px-1.5 py-1">
                  {g.bookmarks.map((b) => (
                    <Row
                      key={b.id}
                      b={b}
                      main={b.id === mainOf(g)}
                      disabled={busy}
                      collection={collectionName(b.collection_id)}
                      saved={saved(b.created_at)}
                      onChoose={() => setMains((prev) => ({ ...prev, [g.key]: b.id }))}
                    />
                  ))}
                </div>
                <p className="px-4 py-2.5 text-xs text-muted" data-after>
                  {after(g)}
                </p>
              </section>
            ))}
          </div>
        )}
      </div>
      {confirming && groups && (
        <ConfirmDialog
          title={t("duplicates.confirmTitle", { count: groups.length })}
          text={t("duplicates.confirmText", { from: total, to: groups.length, trashed: total - groups.length })}
          confirm={t("duplicates.confirm")}
          onClose={() => setConfirming(false)}
          onConfirm={async () => {
            setConfirming(false);
            await merge(groups.map(planOf));
          }}
        />
      )}
    </>
  );
}

const shortDate = (date: Date, language: string) =>
  date.toLocaleDateString(language, { day: "numeric", month: "short", ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }) });

/** One bookmark of a group: the main one is chosen with the radio (sheet 34). */
function Row({
  b,
  main,
  disabled,
  collection,
  saved,
  onChoose,
}: {
  b: Bookmark;
  main: boolean;
  disabled: boolean;
  collection: string | null;
  saved: string;
  onChoose: () => void;
}) {
  const { t } = useTranslation();
  const tags = b.tags ?? [];
  return (
    <button
      type="button"
      role="radio"
      aria-checked={main}
      disabled={disabled}
      onClick={onChoose}
      data-bookmark-id={b.id}
      className={`flex min-h-[52px] w-full items-center gap-3.5 rounded-lg px-2.5 py-1 text-left transition-colors duration-150 ${main ? "bg-accent-soft" : "hover:bg-panel"}`}
    >
      <span className={`flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px] bg-card ${main ? "border-accent" : "border-subtle"}`}>
        {main && <span className="size-2 rounded-full bg-accent" />}
      </span>
      <span className="h-11 w-16 shrink-0 overflow-hidden rounded-md">
        <Preview b={b} mark={16} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-md font-medium">{b.title}</span>
        <span className="flex min-w-0 items-center gap-2 text-xs text-subtle">
          {main && <span className="shrink-0 rounded-sm bg-card px-1.5 text-2xs font-semibold text-accent">{t("duplicates.main")}</span>}
          <span className="truncate">
            {b.url}
            {b.notes?.trim() ? ` · ${t("duplicates.note_label", { note: b.notes.trim() })}` : ""}
          </span>
        </span>
      </span>
      {/* Tags need the room of a wide window; merging keeps them anyway, the line below lists them. */}
      <span className="flex w-[180px] shrink-0 flex-wrap gap-1 max-[1199px]:hidden">
        {tags.slice(0, 3).map((tag) => (
          <span key={tag} className="rounded-[5px] bg-secondary px-1.5 py-px text-2xs text-icon">
            {tag}
          </span>
        ))}
      </span>
      <span className="flex w-[120px] shrink-0 items-center gap-2 text-xs">
        {collection ? (
          <>
            <Dot color={collectionColor(b.collection_id!)} />
            <span className="truncate text-icon">{collection}</span>
          </>
        ) : (
          <span className="text-subtle">{t("duplicates.noCollection")}</span>
        )}
      </span>
      <span className="flex w-4 shrink-0">{b.is_favorite && <Icon icon={Star} size={13} className="fill-accent text-accent" aria-label={t("card.isFavorite")} />}</span>
      <span className="w-[120px] shrink-0 text-right text-xs text-subtle">{saved}</span>
    </button>
  );
}
