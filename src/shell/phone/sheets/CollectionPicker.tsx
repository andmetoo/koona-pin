import { type CSSProperties, useEffect, useRef, useState } from "react";
import { Check, FolderPlus, Sparkles } from "lucide-react";
import { api } from "../../../services/api";
import { collectionColor } from "../../../services/collections";
import { describeError } from "../../../services/errors";
import type { Suggestion } from "../../../types";
import { usePhone } from "../PhoneContext";
import { Button } from "../ui/buttons";
import { SearchField } from "../ui/controls";
import { PhIcon } from "../ui/icons";
import { Sheet, useCloseSheet } from "../ui/Sheet";
import { type Choice, firstChoice, isNew, matching, newName, toggle } from "./editingLogic";
import "./editing.css";

/**
 * `bookmarkIds`: the links being filed. Without `onPick`, Done moves them (one command to undo,
 * as the desktop's Move to and the selection bar's move do). With `onPick`, Done only hands the
 * choice back and moves nothing (the editor's draft, a triage decision): a new collection is
 * created first and its id handed back. `selected`: the caller's current choice (null: none);
 * `title`: the subtitle, when the caller knows the link better than the loaded list does.
 */
export type CollectionPickerProps = {
  bookmarkIds: number[];
  selected?: number | null;
  onPick?: (collectionId: number | null) => void;
  title?: string;
};

/**
 * C1 File into collection: a detached sheet. A find-or-create field; for one link the
 * suggestion of the app (`suggest_collection`, as triage's: where the site's other links mostly
 * lie) on an accent-soft row; every collection with its count and a round check; New collection.
 * A bookmark has one collection, so the choice is single (a radio group); the chosen one tapped
 * again leaves it without one.
 */
export function CollectionPicker({ props }: { props: CollectionPickerProps }) {
  const { app } = usePhone();
  const { t, library } = app;
  const { collections } = library;
  const close = useCloseSheet();
  const field = useRef<HTMLDivElement>(null);
  const ids = props.bookmarkIds;
  const one = ids.length === 1 ? ids[0] : null;
  const bookmark = one === null ? undefined : (library.bookmarks.find((b) => b.id === one) ?? (app.editing?.id === one ? app.editing : undefined));
  const current = bookmark?.collection_id ?? null;

  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [choice, setChoice] = useState<Choice>(() => firstChoice(collections, { selected: props.selected, current }));
  const [touched, setTouched] = useState(false);
  const touchedRef = useRef(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  /** "New collection" was tapped with the field empty: the field asks for the name. */
  const [naming, setNaming] = useState(false);

  useEffect(() => {
    if (one === null) return;
    let live = true;
    api.suggestCollection(one).then(
      (value) => {
        if (!live) return;
        setSuggestion(value);
        // A link without a collection starts on the suggestion, until the person picks.
        if (!touchedRef.current && value) setChoice((was) => (was === null ? firstChoice(collections, { selected: props.selected, current, suggested: value.collection_id }) : was));
      },
      () => {},
    );
    return () => {
      live = false;
    };
    // Asked once, when the sheet opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [one]);

  const pick = (option: Choice) => {
    touchedRef.current = true;
    setTouched(true);
    setChoice((was) => toggle(was, option));
  };

  const suggested = suggestion && collections.find((c) => c.id === suggestion.collection_id);
  const found = matching(collections, query);
  const showSuggested = !!suggested && found.includes(suggested);
  const rest = found.filter((c) => c !== suggested || !showSuggested);
  const typedName = newName(collections, query);

  const done = async () => {
    if (busy) return;
    if (props.onPick) {
      let id: number | null;
      if (isNew(choice)) {
        setBusy(true);
        try {
          id = (await api.createCollection(choice.create)).id;
          await library.refreshCatalog();
        } catch (err) {
          setBusy(false);
          app.say(describeError(err), true);
          return;
        }
      } else id = choice;
      props.onPick(id);
      close();
      return;
    }
    close();
    if (isNew(choice)) app.runBulk({ action: "new_collection", name: choice.create }, ids);
    else if (bookmark) {
      if (choice !== current) app.actions.move(bookmark, choice);
    }
    // Links not loaded here (several, or one from elsewhere): moved as chosen; "none" only when
    // the person picked it, never by an untouched Done.
    else if (choice !== null || touched) app.runBulk({ action: "move", collection_id: choice }, ids);
  };

  const subtitle = one === null ? t("phone.collectionPicker.several", { count: ids.length }) : props.title || bookmark?.title || bookmark?.url;

  return (
    <Sheet
      label={t("phone.collectionPicker.title")}
      title={t("phone.collectionPicker.title")}
      subtitle={subtitle && <span data-user-text>{subtitle}</span>}
      closeButton={false}
      footer={
        <Button kind="primary" block disabled={busy} onClick={() => void done()}>
          {t("phone.collectionPicker.done")}
        </Button>
      }
    >
      <div ref={field}>
        <SearchField
          className="cp-search"
          value={query}
          onChange={setQuery}
          enterKeyHint="done"
          aria-label={t("phone.collectionPicker.find")}
          placeholder={t(naming ? "phone.collectionPicker.namePlaceholder" : "phone.collectionPicker.find")}
          onBlur={() => setNaming(false)}
          onKeyDown={(e) => {
            // Enter on a new name chooses it, as tapping its row does; on one match, that one.
            if (e.key !== "Enter") return;
            e.preventDefault();
            if (typedName) pick({ create: typedName });
            else if (found.length === 1) pick(found[0].id);
            e.currentTarget.blur();
          }}
        />
      </div>
      <div role="radiogroup" aria-label={t("phone.collectionPicker.title")}>
        {showSuggested && suggested && suggestion && (
          <>
            <h3 className="cp-label">{t("phone.collectionPicker.suggested")}</h3>
            <button type="button" role="radio" aria-checked={choice === suggested.id} className="cp-suggested" onClick={() => pick(suggested.id)}>
              <span className="ph-chip-dot" style={{ "--dot": collectionColor(suggested.id) } as CSSProperties} />
              <span className="cp-text">
                <b data-user-text>{suggested.name}</b>
                <span className="cp-why">
                  <PhIcon icon={Sparkles} size={12} strokeWidth={1.4} />
                  {t("phone.collectionPicker.suggestedWhy", { count: suggestion.count, filed: suggestion.filed })}
                </span>
              </span>
              <CheckMark />
            </button>
          </>
        )}
        {(rest.length > 0 || !showSuggested) && <h3 className="cp-label">{t("phone.collectionPicker.all")}</h3>}
        <div className="ph-shelf cp-shelf">
          {rest.map((c) => (
            <button key={c.id} type="button" role="radio" aria-checked={choice === c.id} className="cp-row" onClick={() => pick(c.id)}>
              <span className="ph-chip-dot" style={{ "--dot": collectionColor(c.id) } as CSSProperties} />
              <span className="cp-name" data-user-text>
                {c.name}
              </span>
              <span className="cp-count">{c.count ?? ""}</span>
              <CheckMark />
            </button>
          ))}
          {query.trim() && !found.length && !typedName && <p className="cp-empty">{t("phone.collectionPicker.nothing")}</p>}
          {typedName ? (
            <button
              type="button"
              role="radio"
              aria-checked={isNew(choice) && choice.create === typedName}
              className="cp-row cp-new"
              onClick={() => pick({ create: typedName })}
            >
              <PhIcon icon={FolderPlus} />
              <span className="cp-name" data-user-text>
                {t("phone.collectionPicker.newNamed", { name: typedName })}
              </span>
              <CheckMark />
            </button>
          ) : isNew(choice) ? (
            // Chosen by its name, then the field was cleared: still there to see and undo.
            <button type="button" role="radio" aria-checked className="cp-row cp-new" onClick={() => pick(choice)}>
              <PhIcon icon={FolderPlus} />
              <span className="cp-name" data-user-text>
                {t("phone.collectionPicker.newNamed", { name: choice.create })}
              </span>
              <CheckMark />
            </button>
          ) : (
            // Without a name yet: the field asks for one.
            <button
              type="button"
              className="cp-row cp-new"
              onClick={() => {
                setNaming(true);
                field.current?.querySelector("input")?.focus();
              }}
            >
              <PhIcon icon={FolderPlus} />
              <span className="cp-name">{t("phone.collectionPicker.new")}</span>
            </button>
          )}
        </div>
      </div>
    </Sheet>
  );
}

/** The round check of a row: an empty ring, or the accent disc with a tick when its row is chosen. */
function CheckMark() {
  return (
    <span className="cp-check" aria-hidden="true">
      <Check size={14} strokeWidth={2.5} absoluteStrokeWidth className="cp-tick" />
    </span>
  );
}
