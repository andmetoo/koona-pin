import { FormEvent, KeyboardEvent, useRef, useState } from "react";
import { AlertCircle, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Bookmark, Collection } from "../../types";
import { describeError } from "../../services/errors";
import { shortcut } from "../../services/keys";
import { Icon } from "../icons";
import { Button } from "../ui/Button";
import { Field } from "../ui/Controls";
import { Kbd } from "../ui/Hint";
import { Preview, SiteMark } from "./Bookmarks";
import { CollectionSelect, TagInput } from "./Fields";

export interface BookmarkChanges {
  title: string;
  notes: string;
  collection_id: number | null;
  tags: string[];
}

/** «trezor.io/trezor-safe-5»: the address without the scheme and «www.». */
function shortUrl(url: string) {
  try {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`.replace(/\/$/, "");
    return `${parsed.host.replace(/^www\./, "")}${path}`;
  } catch {
    return url;
  }
}

/**
 * The bookmark editor of frame 16: preview, page, title, collection, tags,
 * note. An empty title is marked on the field; a failed save shows the reason
 * above the buttons and keeps everything typed (frame 12).
 */
export function BookmarkEditor({
  bookmark,
  startInNotes = false,
  collections,
  onSave,
  onOpen,
  onDelete,
  onCancel,
}: {
  bookmark: Bookmark;
  /** Opened from the note marker (#410): the caret at the end of the note, not in the title. */
  startInNotes?: boolean;
  collections: Collection[];
  onSave: (data: BookmarkChanges) => Promise<void>;
  onOpen: (url: string) => void;
  onDelete: (bookmark: Bookmark) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const form = useRef<HTMLFormElement>(null);
  const titleField = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(bookmark.title);
  const [notes, setNotes] = useState(bookmark.notes ?? "");
  const [collection, setCollection] = useState<number | null>(bookmark.collection_id ?? null);
  const [tags, setTags] = useState(bookmark.tags ?? []);
  const [titleError, setTitleError] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    if (!title.trim()) {
      setTitleError(t("editor.titleRequired"));
      titleField.current?.focus();
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSave({ title: title.trim(), notes, collection_id: collection, tags });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      // Leaving the field first adds a tag still being typed.
      (document.activeElement as HTMLElement | null)?.blur();
      window.setTimeout(() => form.current?.requestSubmit());
    }
  };

  return (
    <form ref={form} noValidate className="flex flex-col gap-4" onSubmit={submit} onKeyDown={onKeyDown}>
      <div className="flex flex-col gap-2.5">
        <button
          type="button"
          data-preview
          onClick={() => onOpen(bookmark.url)}
          aria-label={t("card.open", { title: bookmark.title })}
          className="block h-24 w-full overflow-hidden rounded-xl bg-hover"
        >
          <Preview b={bookmark} />
        </button>
        <button
          type="button"
          onClick={() => onOpen(bookmark.url)}
          title={bookmark.url}
          className="flex min-w-0 items-center gap-2 self-start text-sm text-accent hover:underline"
        >
          <SiteMark b={bookmark} />
          <span className="truncate">{shortUrl(bookmark.url)}</span>
          <Icon icon={ExternalLink} size={14} className="shrink-0" />
        </button>
      </div>
      <Field label={t("editor.title")} error={titleError}>
        {(id, note) => (
          <input
            ref={titleField}
            id={id}
            autoFocus={!startInNotes}
            value={title}
            aria-invalid={!!titleError}
            aria-describedby={note}
            onChange={(e) => {
              setTitle(e.target.value);
              setTitleError("");
            }}
            className="field"
          />
        )}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("editor.collection")}>
          {(id) => <CollectionSelect id={id} value={collection} collections={collections} onChange={setCollection} />}
        </Field>
        <Field label={t("editor.tags")}>{(id) => <TagInput id={id} tags={tags} onChange={setTags} />}</Field>
      </div>
      <Field label={t("editor.notes")}>
        {(id) => (
          <textarea
            id={id}
            autoFocus={startInNotes}
            onFocus={(e) => startInNotes && e.currentTarget.setSelectionRange(notes.length, notes.length)}
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t("editor.notesPlaceholder")}
            className="field resize-y"
          />
        )}
      </Field>
      {error && (
        <div role="alert" className="flex gap-2 rounded-xl bg-danger-soft px-3 py-2.5 text-sm text-on-danger-soft">
          <Icon icon={AlertCircle} size={15} className="mt-0.5 shrink-0" />
          <p>
            {t("editor.saveFailed")} <span className="text-xs opacity-80">{error}</span>
          </p>
        </div>
      )}
      <footer data-editor-actions className="flex items-center gap-2">
        <button type="button" onClick={() => onDelete(bookmark)} className="mr-auto text-sm text-muted hover:text-ink">
          {t("card.delete")}
        </button>
        <Button size="lg" onClick={onCancel}>
          {t("editor.cancel")}
        </Button>
        <Button variant="primary" size="lg" type="submit" disabled={saving} aria-keyshortcuts="Control+Enter">
          {saving ? t("editor.saving") : error ? t("editor.saveAgain") : t("editor.save")}
          {!saving && (
            <span aria-hidden>
              <Kbd className="bg-white/15 text-on-accent">{shortcut("↵")}</Kbd>
            </span>
          )}
        </Button>
      </footer>
    </form>
  );
}
