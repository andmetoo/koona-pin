import { KeyboardEvent, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Collection } from "../../types";
import { collectionColor } from "../../services/collections";
import { Icon } from "../icons";

/** Collection picker of frame 16: the collection's dot before its name. */
export function CollectionSelect({
  id,
  value,
  collections,
  onChange,
}: {
  id: string;
  value: number | null;
  collections: Collection[];
  onChange: (value: number | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="relative">
      {value !== null && (
        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-[7px] -translate-y-1/2 rounded-full"
          style={{ background: collectionColor(value) }}
        />
      )}
      <select
        id={id}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
        className={`field appearance-none pr-8 ${value !== null ? "pl-[26px]" : ""}`}
      >
        <option value="">{t("card.noCollection")}</option>
        {collections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <Icon icon={ChevronDown} size={14} className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-icon" />
    </div>
  );
}

/** Tags are stored lower case, without surrounding spaces (`db::link_tags`). */
const cleanTag = (tag: string, language: string) => tag.trim().toLocaleLowerCase(language);

/**
 * Tags as chips (frame 16): `Enter` or a comma adds the typed tag,
 * `Backspace` in the empty field removes the last one, «×» removes a chip.
 * A tag still being typed is added when the field loses focus.
 */
export function TagInput({
  id,
  tags,
  onChange,
  describedBy,
}: {
  id: string;
  tags: string[];
  onChange: (tags: string[]) => void;
  describedBy?: string;
}) {
  const { t, i18n } = useTranslation();
  const [draft, setDraft] = useState("");
  const add = (text: string) => {
    const next = [...tags];
    for (const part of text.split(",")) {
      const tag = cleanTag(part, i18n.language);
      if (tag && !next.includes(tag)) next.push(tag);
    }
    onChange(next);
    setDraft("");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === "Enter" || e.key === ",") && draft.trim()) {
      e.preventDefault();
      add(draft);
    } else if (e.key === "Backspace" && !draft && tags.length) {
      onChange(tags.slice(0, -1));
    }
  };
  return (
    <div className="field flex min-h-[34px] flex-wrap items-center gap-1 py-1 focus-within:border-accent">
      {tags.map((tag) => (
        <span key={tag} className="flex items-center gap-0.5 rounded-xs bg-line py-0.5 pr-1 pl-[7px] text-2xs text-icon">
          {tag}
          <button
            type="button"
            aria-label={t("editor.removeTag", { tag })}
            onClick={() => onChange(tags.filter((x) => x !== tag))}
            className="rounded-xs text-subtle hover:text-ink"
          >
            <Icon icon={X} size={11} />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={draft}
        aria-describedby={describedBy}
        onChange={(e) => (e.target.value.includes(",") ? add(e.target.value) : setDraft(e.target.value))}
        onKeyDown={onKeyDown}
        onBlur={() => draft.trim() && add(draft)}
        placeholder={t("editor.tagsPlaceholder")}
        className="min-w-[64px] flex-1 bg-transparent text-sm outline-none placeholder:text-subtle"
      />
    </div>
  );
}
