import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Bookmark, Collection } from "../../types";
import { describeError } from "../../services/errors";
import { Icon } from "../icons";
import { Button } from "../ui/Button";
import { Field } from "../ui/Controls";

/** Edit title, collection, tags and note. A failed save keeps what was typed. */
export function BookmarkEditor({
  bookmark,
  collections,
  onSave,
  onOpen,
}: {
  bookmark: Bookmark;
  collections: Collection[];
  onSave: (data: { title: string; notes: string; collection_id: number | null; tags: string[] }) => Promise<void>;
  onOpen: (url: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [title, setTitle] = useState(bookmark.title);
  const [notes, setNotes] = useState(bookmark.notes ?? "");
  const [collection, setCollection] = useState<number | null>(bookmark.collection_id ?? null);
  const [tags, setTags] = useState((bookmark.tags ?? []).join(", "));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        setError("");
        try {
          await onSave({
            title: title.trim(),
            notes,
            collection_id: collection,
            tags: tags
              .split(",")
              .map((tag) => tag.trim().toLocaleLowerCase(i18n.language))
              .filter(Boolean),
          });
        } catch (err) {
          setError(describeError(err));
        } finally {
          setSaving(false);
        }
      }}
    >
      <Field label={t("editor.title")}>
        {(id) => <input id={id} autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} className="field" />}
      </Field>
      <Field label={t("editor.collection")}>
        {(id) => (
          <select
            id={id}
            value={collection ?? ""}
            onChange={(e) => setCollection(e.target.value ? Number(e.target.value) : null)}
            className="field"
          >
            <option value="">{t("card.noCollection")}</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label={t("editor.tags")} hint={t("editor.tagsHint")}>
        {(id, note) => <input id={id} aria-describedby={note} value={tags} onChange={(e) => setTags(e.target.value)} className="field" />}
      </Field>
      <Field label={t("editor.notes")}>
        {(id) => (
          <textarea
            id={id}
            rows={5}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t("editor.notesPlaceholder")}
            className="field resize-y"
          />
        )}
      </Field>
      <button
        type="button"
        onClick={() => onOpen(bookmark.url)}
        className="flex items-center gap-1 self-start text-xs text-muted hover:text-ink"
      >
        {bookmark.domain}
        <Icon icon={ArrowUpRight} size={14} />
      </button>
      {error && (
        <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2.5 text-sm text-on-danger-soft">
          {error}
        </p>
      )}
      <footer className="flex justify-end">
        <Button variant="primary" size="lg" type="submit" disabled={saving}>
          {saving ? t("editor.saving") : error ? t("editor.saveAgain") : t("editor.save")}
        </Button>
      </footer>
    </form>
  );
}
