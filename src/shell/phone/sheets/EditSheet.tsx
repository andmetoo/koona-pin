import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { AlertCircle, ChevronDown, Folder, Hash, Plus, Trash2, X } from "lucide-react";
import { cleanTag, SEPARATORS, useCommaEnds } from "../../../components/library/Fields";
import { describeError } from "../../../services/errors";
import { composing } from "../../../services/ime";
import type { Bookmark } from "../../../types";
import { usePhone } from "../PhoneContext";
import { Button } from "../ui/buttons";
import { Chip } from "../ui/controls";
import { CollectionGlyph } from "../ui/CollectionGlyph";
import { PhIcon } from "../ui/icons";
import { Sheet, SheetBar, useCloseSheet } from "../ui/Sheet";
import { tagSuggestions } from "./editingLogic";
import { LinkThumb } from "./LinkThumb";
import "./editing.css";

/** No props: the bookmark is `app.editing`; the shell opens this sheet when it is set. */
export type EditSheetProps = Record<string, never>;

/**
 * B1 Edit link: the attached full-height sheet with Cancel · Edit link · Save in its top bar, so
 * Save stays above the keyboard. Open it with `app.setEditing(bookmark)`; closing it closes the
 * editor (useAppSheets). The form is keyed by the bookmark: another bookmark is a new draft.
 */
export function EditSheet(_: { props: EditSheetProps }) {
  const { app } = usePhone();
  // While the sheet leaves, the editor is already closed: it keeps showing the last bookmark.
  const last = useRef<Bookmark | null>(app.editing);
  if (app.editing) last.current = app.editing;
  const bookmark = last.current;
  if (!bookmark) return <Sheet variant="attached" label={app.t("phone.edit.title")} />;
  return <EditForm key={bookmark.id} bookmark={bookmark} />;
}

/** «inkandswitch.com/local-first»: the address without the scheme and «www.». */
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
 * The editor's form, with the desktop editor's rules (BookmarkEditor): an empty title is marked
 * on its field and keeps the focus; a failed save says why and keeps everything typed, Save
 * becomes "Save again"; Cancel leaves the draft without asking, as the desktop's does. Opened
 * from triage, Save and Move to Trash are triage decisions (`saveEdit`, `deleteEdit`).
 */
function EditForm({ bookmark }: { bookmark: Bookmark }) {
  const { app, sheets } = usePhone();
  const { t } = app;
  const close = useCloseSheet();
  const formId = useId();
  const titleId = useId();
  const titleNote = useId();
  const titleField = useRef<HTMLTextAreaElement>(null);
  const [title, setTitle] = useState(bookmark.title);
  const [notes, setNotes] = useState(bookmark.notes ?? "");
  const [collection, setCollection] = useState<number | null>(bookmark.collection_id ?? null);
  const [tags, setTags] = useState(bookmark.tags ?? []);
  const [titleError, setTitleError] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // The title has the focus (and the keyboard) with the caret at its end, as in B1.
  useEffect(() => {
    const field = titleField.current;
    if (!field) return;
    field.focus({ preventScroll: true });
    field.setSelectionRange(field.value.length, field.value.length);
  }, []);

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
      // Saved, the editor closes, and the sheet with it.
      await app.saveEdit({ title: title.trim(), notes, collection_id: collection, tags });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  };

  const chosen = app.library.collections.find((c) => c.id === collection);
  const pickCollection = () =>
    sheets.open({
      kind: "collectionPicker",
      props: { bookmarkIds: [bookmark.id], title: title.trim() || bookmark.url, selected: chosen ? chosen.id : null, onPick: setCollection },
    });

  return (
    <Sheet
      variant="attached"
      label={t("phone.edit.title")}
      className="ed-sheet"
      bar={
        <SheetBar
          left={
            <Button compact onClick={close}>
              {t("common.cancel")}
            </Button>
          }
          title={t("phone.edit.title")}
          right={
            <Button compact kind="primary" type="submit" form={formId} disabled={saving}>
              {saving ? t("editor.saving") : error ? t("editor.saveAgain") : t("phone.edit.save")}
            </Button>
          }
        />
      }
    >
      <form id={formId} noValidate className="ed-form" onSubmit={submit}>
        <button type="button" className="ed-site" aria-label={t("phone.edit.openPage", { site: bookmark.domain })} onClick={() => app.actions.open(bookmark.url)}>
          <LinkThumb bookmark={bookmark} size={56} />
          <span className="ed-site-text">
            <b data-user-text>{bookmark.domain}</b>
            <span className="ph-meta" data-user-text>
              {shortUrl(bookmark.url)}
            </span>
          </span>
        </button>

        <div className="ph-field ed-field" data-multiline data-invalid={titleError ? "" : undefined}>
          <label htmlFor={titleId} className="ph-field-label">
            {t("phone.edit.titleField")}
          </label>
          <textarea
            ref={titleField}
            id={titleId}
            rows={1}
            value={title}
            enterKeyHint="done"
            aria-invalid={!!titleError}
            aria-describedby={titleError ? titleNote : undefined}
            onChange={(e) => {
              // A title is one line: a pasted line break becomes a space.
              setTitle(e.target.value.replace(/\s*[\r\n]+\s*/g, " "));
              setTitleError("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !composing(e)) {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
          />
        </div>
        {titleError && (
          <p id={titleNote} className="ed-field-note">
            {titleError}
          </p>
        )}

        <div className="ph-field ed-field ed-note" data-multiline>
          <label htmlFor={`${titleId}-note`} className="ph-field-label">
            {t("phone.edit.noteField")}
          </label>
          <textarea id={`${titleId}-note`} rows={1} value={notes} placeholder={t("phone.edit.notePlaceholder")} onChange={(e) => setNotes(e.target.value)} />
        </div>

        <button type="button" className="ed-collection" onClick={pickCollection}>
          <PhIcon icon={Folder} at="field" />
          <span className="ed-collection-label">{t("phone.edit.collection")}</span>
          <span className="ed-collection-chip">
            {chosen && <CollectionGlyph collection={chosen} />}
            <span className="ed-collection-name" data-user-text>
              {chosen ? chosen.name : t("phone.edit.noCollection")}
            </span>
            <PhIcon icon={ChevronDown} size={14} strokeWidth={1.5} />
          </span>
        </button>

        <Tags tags={tags} onChange={setTags} />

        {error && (
          <div role="alert" className="ed-alert">
            <PhIcon icon={AlertCircle} at="field" />
            <p>
              {t("editor.saveFailed")} <span className="ed-alert-reason">{error}</span>
            </p>
          </div>
        )}

        <Button kind="ghost" icon={Trash2} className="ed-trash" onClick={() => app.deleteEdit(bookmark)}>
          {t("phone.edit.trash")}
        </Button>
      </form>
    </Sheet>
  );
}

/**
 * Tags as chips with `#`; a tap on one takes it off. "+ Add tag" turns into a field: Enter, Done
 * or a comma adds what is typed (the desktop's rules, Fields.tsx: lower case, a comma of any
 * script ends a tag, an IME's Enter confirms the character); leaving the field adds a tag still
 * being typed. The library's tags that match are offered under it.
 */
function Tags({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const { app } = usePhone();
  const { t, i18n } = app;
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const listId = useId();
  const add = (text: string) => {
    const next = [...tags];
    for (const part of text.split(SEPARATORS)) {
      const tag = cleanTag(part, i18n.language);
      if (tag && !next.includes(tag)) next.push(tag);
    }
    onChange(next);
    setDraft("");
  };
  const commas = useCommaEnds(add);
  const offered = adding ? tagSuggestions(app.library.tags, draft, tags) : [];
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (composing(e)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (draft.trim()) add(draft);
      else setAdding(false);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setDraft("");
      setAdding(false);
    } else if (e.key === "Backspace" && !draft && tags.length) {
      onChange(tags.slice(0, -1));
    }
  };
  return (
    <div className="ed-tags">
      <div className="ed-tag-row">
        {tags.map((tag) => (
          <Chip key={tag} icon={Hash} aria-pressed={undefined} aria-label={t("phone.edit.removeTag", { tag })} onClick={() => onChange(tags.filter((x) => x !== tag))}>
            <span data-user-text>{tag}</span>
            <PhIcon icon={X} size={14} strokeWidth={1.5} className="ed-tag-x" />
          </Chip>
        ))}
        {adding ? (
          <label className="ed-tag-input">
            <PhIcon icon={Hash} at="chip" />
            <input
              autoFocus
              aria-label={t("phone.edit.tagField")}
              aria-controls={offered.length ? listId : undefined}
              value={draft}
              enterKeyHint="done"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => commas.ended(e) || setDraft(e.target.value)}
              onCompositionEnd={commas.onCompositionEnd}
              onKeyDown={onKeyDown}
              onBlur={() => {
                if (draft.trim()) add(draft);
                setAdding(false);
              }}
            />
          </label>
        ) : (
          <button type="button" className="ed-add-tag ph-hit" onClick={() => setAdding(true)}>
            <PhIcon icon={Plus} at="chip" />
            {t("phone.edit.addTag")}
          </button>
        )}
      </div>
      {offered.length > 0 && (
        <div id={listId} role="group" aria-label={t("phone.edit.tagSuggestions")} className="ed-tag-row ed-tag-suggestions">
          {offered.map((tag) => (
            <Chip
              key={tag.id}
              icon={Hash}
              aria-pressed={undefined}
              // Keeps the field focused: its blur would close it first.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => add(tag.name)}
            >
              <span data-user-text>{tag.name}</span>
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}
