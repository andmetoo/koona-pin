import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { Bookmark, Collection } from "../../types";
import { describeError } from "../../services/errors";
export function BookmarkEditor({
  bookmark,
  collections,
  onSave,
  onOpen,
}: {
  bookmark: Bookmark;
  collections: Collection[];
  onSave: (data: {
    title: string;
    notes: string;
    collection_id: number | null;
    tags: string[];
  }) => Promise<void>;
  onOpen: (url: string) => void;
}) {
  const [title, setTitle] = useState(bookmark.title);
  const [notes, setNotes] = useState(bookmark.notes ?? "");
  const [collection, setCollection] = useState<number | null>(
    bookmark.collection_id ?? null,
  );
  const [tags, setTags] = useState((bookmark.tags ?? []).join(", "));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <form
      className="study-form"
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
              .map((t) => t.trim().toLocaleLowerCase("ru"))
              .filter(Boolean),
          });
        } catch (err) {
          setError(describeError(err));
        } finally {
          setSaving(false);
        }
      }}
    >
      <label>
        Название
        <input
          autoFocus
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label>
        Коллекция
        <select
          aria-label="Коллекция"
          value={collection ?? ""}
          onChange={(e) =>
            setCollection(e.target.value ? Number(e.target.value) : null)
          }
        >
          <option value="">Без коллекции</option>
          {collections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Теги
        <input
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="Через запятую"
        />
      </label>
      <label>
        Заметка
        <textarea
          rows={5}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Что хочется запомнить?"
        />
      </label>
      <button
        type="button"
        className="study-button quiet"
        onClick={() => onOpen(bookmark.url)}
      >
        {bookmark.domain}
        <ArrowUpRight size={14} />
      </button>
      {error && (
        <p role="alert" className="study-error">
          {error}
        </p>
      )}
      <footer>
        <button
          disabled={saving}
          type="submit"
          className="study-button primary"
        >
          {saving ? "Сохраняется…" : "Сохранить изменения"}
        </button>
      </footer>
    </form>
  );
}
