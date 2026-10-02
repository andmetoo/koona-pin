import { useEffect, useRef, useState } from "react";
import {
  Copy,
  Globe,
  Heart,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import { Bookmark, Collection } from "../../types";
import { Preview } from "../../concepts/Preview";
export function LibraryCard({
  bookmark: b,
  collections,
  onOpen,
  onFavorite,
  onEdit,
  onDelete,
  onCopy,
  onTag,
}: {
  bookmark: Bookmark;
  collections: Collection[];
  onOpen: (url: string) => void;
  onFavorite: (b: Bookmark) => void;
  onEdit: (b: Bookmark) => void;
  onDelete: (b: Bookmark) => void;
  onCopy: (url: string) => void;
  onTag: (tag: string) => void;
}) {
  const [broken, setBroken] = useState(false);
  const [faviconBroken, setFaviconBroken] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => setBroken(false), [b.image_url]);
  useEffect(() => setFaviconBroken(false), [b.favicon_url]);
  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node))
        menu.current?.removeAttribute("open");
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && menu.current?.open) {
        menu.current.removeAttribute("open");
        menu.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  const collection = collections.find((c) => c.id === b.collection_id);
  const date = new Date(b.created_at).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "short",
  });
  const action = (fn: () => void) => {
    menu.current?.removeAttribute("open");
    fn();
  };
  return (
    <article className="study-bookmark" data-bookmark-id={b.id}>
      <button
        className="study-preview-link"
        onClick={() => onOpen(b.url)}
        aria-label={`Открыть: ${b.title}`}
      >
        {b.preview_kind ? (
          <Preview kind={b.preview_kind} />
        ) : b.image_url && !broken ? (
          <img
            className="bookmark-image"
            src={b.image_url}
            alt=""
            loading="lazy"
            onError={() => setBroken(true)}
          />
        ) : (
          <div className="bookmark-fallback">
            <Globe size={28} strokeWidth={1} />
            <span>{b.domain}</span>
          </div>
        )}
      </button>
      <div className="study-card-body">
        <div className="study-card-source">
          <span className="study-site-mark">
            {b.favicon_url && !faviconBroken ? (
              <img
                src={b.favicon_url}
                alt=""
                onError={() => setFaviconBroken(true)}
              />
            ) : (
              b.domain[0]?.toUpperCase()
            )}
          </span>
          <span>{b.domain}</span>
          <button
            className={`study-icon favorite ${b.is_favorite ? "is-favorite" : ""}`}
            aria-label={b.is_favorite ? "Убрать из избранного" : "В избранное"}
            aria-pressed={b.is_favorite}
            onClick={() => onFavorite(b)}
          >
            <Heart size={15} />
          </button>
        </div>
        <h2>
          <button onClick={() => onOpen(b.url)} title={b.title}>
            {b.title || b.url}
          </button>
        </h2>
        <p className="study-description">
          {b.description || "Описание этой страницы ещё не добавлено."}
        </p>
        <div className="study-card-tags">
          {(b.tags ?? []).slice(0, 2).map((t) => (
            <button key={t} onClick={() => onTag(t)}>
              #{t}
            </button>
          ))}
        </div>
        <footer>
          <span>{collection?.name || "Без коллекции"}</span>
          <time dateTime={b.created_at}>{date}</time>
          <details ref={menu} className="study-card-menu">
            <summary aria-label={`Действия: ${b.title}`}>
              <MoreHorizontal size={18} />
            </summary>
            <div>
              <button onClick={() => action(() => onEdit(b))}>
                <Pencil size={14} />
                Редактировать
              </button>
              <button onClick={() => action(() => onCopy(b.url))}>
                <Copy size={14} />
                Копировать ссылку
              </button>
              <button
                className="danger"
                onClick={() => action(() => onDelete(b))}
              >
                <Trash2 size={14} />
                Удалить
              </button>
            </div>
          </details>
        </footer>
      </div>
    </article>
  );
}
