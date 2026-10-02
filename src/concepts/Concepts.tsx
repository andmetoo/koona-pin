import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpRight,
  Bookmark,
  Check,
  ChevronDown,
  Copy,
  Folder,
  Globe,
  Grid2X2,
  Hash,
  Heart,
  Link,
  List,
  Minus,
  Moon,
  MoreHorizontal,
  Plus,
  Search,
  Settings2,
  Square,
  Sun,
  X,
} from "lucide-react";
import { collectionNames, ConceptBookmark, seedBookmarks } from "./data";
import { Preview } from "./Preview";

type Direction = "catalog" | "editorial";
type Surface =
  "add" | "import" | "connect" | "settings" | "delete" | "collection" | null;
const directionNames = { catalog: "Каталог", editorial: "Редакция" };

function StudyDialog({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => {
      ref.current?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="study-dialog"
      onCancel={close}
      onClick={(e) => {
        if (e.target === ref.current) close();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button className="study-icon" aria-label="Закрыть" onClick={close}>
          <X size={18} />
        </button>
      </header>
      {children}
    </dialog>
  );
}

export function Concepts() {
  const params = new URLSearchParams(location.search);
  const [direction, setDirection] = useState<Direction>(
    params.get("direction") === "catalog" ? "catalog" : "editorial",
  );
  const [dark, setDark] = useState(params.get("theme") === "dark");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [bookmarks, setBookmarks] = useState<ConceptBookmark[]>(seedBookmarks);
  const [collections, setCollections] = useState(collectionNames);
  const [section, setSection] = useState("Все закладки");
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("");
  const [domain, setDomain] = useState("");
  const [surface, setSurface] = useState<Surface>(null);
  const [editing, setEditing] = useState<ConceptBookmark | null>(null);
  const [deleting, setDeleting] = useState<ConceptBookmark | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [draftUrl, setDraftUrl] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftCollection, setDraftCollection] = useState("");
  const [draftTags, setDraftTags] = useState("");
  const [importContent, setImportContent] = useState("");
  const [newCollection, setNewCollection] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const editDialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    document.documentElement.dataset.studyTheme = dark ? "dark" : "light";
    const next = new URL(location.href);
    next.searchParams.set("direction", direction);
    next.searchParams.set("theme", dark ? "dark" : "light");
    history.replaceState(null, "", next);
  }, [dark, direction]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2800);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!editing) return;
    const previous = document.activeElement as HTMLElement | null;
    editDialog.current?.showModal();
    return () => {
      editDialog.current?.close();
      previous?.focus();
    };
  }, [editing?.id]);

  const filtered = bookmarks.filter(
    (b) =>
      (section === "Все закладки" ||
        (section === "Избранное" && b.favorite) ||
        section === b.collection) &&
      (!tag || b.tags.includes(tag)) &&
      (!domain || b.domain === domain) &&
      (!query ||
        [b.title, b.description, b.domain, b.notes, ...b.tags]
          .join(" ")
          .toLocaleLowerCase("ru")
          .includes(query.toLocaleLowerCase("ru"))),
  );
  const tags = [...new Set(bookmarks.flatMap((b) => b.tags))];
  const domains = [...new Set(bookmarks.map((b) => b.domain))];
  const navigate = (name: string) => {
    setSection(name);
    setTag("");
    setDomain("");
  };
  const openSurface = (value: Surface) => {
    setError("");
    setSurface(value);
  };
  const toggleFavorite = (id: number) =>
    setBookmarks((prev) =>
      prev.map((b) => (b.id === id ? { ...b, favorite: !b.favorite } : b)),
    );
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setNotice("Ссылка скопирована");
    } catch {
      setNotice("Копирование недоступно в этом браузере");
    }
  };

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    let url: URL;
    try {
      url = new URL(draftUrl.trim());
      if (!["https:", "http:"].includes(url.protocol)) throw new Error();
    } catch {
      setError("Введите полную ссылку, начинающуюся с https:// или http://");
      return;
    }
    if (bookmarks.some((b) => b.url === url.href)) {
      setError("Эта ссылка уже есть в библиотеке");
      return;
    }
    setBookmarks((prev) => [
      {
        id: Date.now(),
        title: draftTitle.trim() || url.hostname,
        url: url.href,
        domain: url.hostname.replace(/^www\./, ""),
        description: "",
        collection: draftCollection,
        tags: draftTags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        date: "Сегодня",
        favorite: false,
        preview: "article",
        notes: "",
      },
      ...prev,
    ]);
    setSurface(null);
    setDraftUrl("");
    setDraftTitle("");
    setDraftTags("");
    setNotice("Добавлено в демонстрационную библиотеку");
  };
  const doImport = () => {
    const html = new DOMParser().parseFromString(importContent, "text/html");
    const imported: ConceptBookmark[] = [];
    html.querySelectorAll("a[href]").forEach((a, i) => {
      try {
        const url = new URL(a.getAttribute("href")!);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          bookmarks.some((b) => b.url === url.href) ||
          imported.some((b) => b.url === url.href)
        )
          return;
        imported.push({
          id: Date.now() + i,
          title: a.textContent?.trim() || url.hostname,
          url: url.href,
          domain: url.hostname,
          description: "",
          collection: "",
          tags: [],
          date: "Сегодня",
          favorite: false,
          preview: "article",
          notes: "",
        });
      } catch {
        /* Skip invalid links in the demonstration import. */
      }
    });
    if (!imported.length) {
      setError("В файле нет новых ссылок HTTP/HTTPS");
      return;
    }
    setBookmarks((prev) => [...imported, ...prev]);
    setSurface(null);
    setImportContent("");
    setNotice(`Импортировано ссылок: ${imported.length}`);
  };

  return (
    <div className={`study-root study-${direction}`}>
      <div className="study-controls">
        <div className="study-label">
          <span className="study-dot" />
          <span>
            OddClicks <span className="study-muted">/ Концепты интерфейса</span>
          </span>
        </div>
        <div className="study-control-actions">
          <div
            className="study-segment"
            role="group"
            aria-label="Визуальное направление"
          >
            {(["catalog", "editorial"] as Direction[]).map((d) => (
              <button
                key={d}
                aria-pressed={direction === d}
                onClick={() => setDirection(d)}
              >
                {directionNames[d]}
              </button>
            ))}
          </div>
          <button
            className="study-theme"
            onClick={() => setDark(!dark)}
            aria-label={dark ? "Светлая тема" : "Тёмная тема"}
          >
            {dark ? <Sun size={16} /> : <Moon size={16} />}
            <span>{dark ? "Тёмная" : "Светлая"}</span>
          </button>
        </div>
      </div>

      <div className="study-window">
        <header className="study-titlebar">
          <span className="study-wordmark">
            <Bookmark size={14} />
            OddClicks
          </span>
          <div aria-label="Кнопки окна в макете">
            <Minus size={13} />
            <Square size={11} />
            <X size={14} />
          </div>
        </header>
        <div className="study-workspace">
          <aside className="study-sidebar">
            <div className="study-sidebar-scroll">
              <div className="study-brand">
                <span className="study-logo">
                  <Bookmark size={23} strokeWidth={1.6} />
                </span>
                <div>
                  OddClicks<small>Место для хороших находок</small>
                </div>
              </div>
              <nav className="study-primary-nav" aria-label="Библиотека">
                <button
                  className={section === "Все закладки" ? "active" : ""}
                  onClick={() => navigate("Все закладки")}
                >
                  <Bookmark size={17} />
                  <span>Все закладки</span>
                  <small>{bookmarks.length.toString().padStart(2, "0")}</small>
                </button>
                <button
                  className={section === "Избранное" ? "active" : ""}
                  onClick={() => navigate("Избранное")}
                >
                  <Heart size={17} />
                  <span>Избранное</span>
                  <small>
                    {bookmarks
                      .filter((b) => b.favorite)
                      .length.toString()
                      .padStart(2, "0")}
                  </small>
                </button>
              </nav>
              <div className="study-section-label">
                <span>Коллекции</span>
                <button
                  className="study-icon"
                  aria-label="Новая коллекция"
                  onClick={() => openSurface("collection")}
                >
                  <Plus size={15} />
                </button>
              </div>
              <nav className="study-collection-nav" aria-label="Коллекции">
                {collections.map((c, i) => (
                  <button
                    key={c}
                    className={section === c ? "active" : ""}
                    onClick={() => navigate(c)}
                  >
                    <Folder size={16} strokeWidth={1.5} />
                    <span>{c}</span>
                    <small>
                      {bookmarks.filter((b) => b.collection === c).length ||
                        (i > 3 ? 0 : "")}
                    </small>
                  </button>
                ))}
              </nav>
              <details className="study-sidebar-details">
                <summary>
                  <span>Теги</span>
                  <ChevronDown size={14} />
                </summary>
                <div className="study-tag-cloud">
                  {tags.map((t) => (
                    <button
                      key={t}
                      className={tag === t ? "selected" : ""}
                      onClick={() => setTag(tag === t ? "" : t)}
                    >
                      #{t}
                    </button>
                  ))}
                </div>
              </details>
              <details className="study-sidebar-details">
                <summary>
                  <span>Источники</span>
                  <ChevronDown size={14} />
                </summary>
                <nav>
                  {domains.map((d) => (
                    <button
                      key={d}
                      onClick={() => setDomain(domain === d ? "" : d)}
                      className={domain === d ? "active" : ""}
                    >
                      <Globe size={14} />
                      <span>{d}</span>
                    </button>
                  ))}
                </nav>
              </details>
              <div className="study-sidebar-note">
                <span>Сохраняйте интересное.</span>
                <span>Возвращайтесь к важному.</span>
              </div>
            </div>
            <footer className="study-sidebar-footer">
              <button onClick={() => openSurface("connect")}>
                <Link size={16} />
                Подключить браузер
                <ArrowUpRight size={13} />
              </button>
              <button onClick={() => openSurface("settings")}>
                <Settings2 size={16} />
                Настройки
              </button>
            </footer>
          </aside>

          <main className="study-main">
            <div className="study-main-scroll">
              <div className="study-heading-row">
                <div>
                  <p className="study-eyebrow">Личная библиотека</p>
                  <h1>
                    {section}
                    <span className="study-heading-count">
                      {bookmarks.length}
                    </span>
                  </h1>
                  <p className="study-subtitle">
                    Всё, что хочется сохранить. И легко найти снова.
                  </p>
                </div>
                <button
                  className="study-button primary"
                  onClick={() => openSurface("add")}
                >
                  <Plus size={17} />
                  Добавить ссылку
                </button>
              </div>
              <div className="study-toolbar">
                <label className="study-search">
                  <Search size={17} />
                  <input
                    ref={searchRef}
                    aria-label="Поиск в библиотеке"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Найти в библиотеке"
                  />
                  <kbd>Ctrl K</kbd>
                </label>
                <button
                  className="study-button quiet import-action"
                  onClick={() => openSurface("import")}
                >
                  <ArrowDownToLine size={16} />
                  <span>Импорт</span>
                </button>
                <div
                  className="study-view"
                  role="group"
                  aria-label="Вид библиотеки"
                >
                  <button
                    aria-label="Сетка"
                    aria-pressed={view === "grid"}
                    onClick={() => setView("grid")}
                  >
                    <Grid2X2 size={17} />
                  </button>
                  <button
                    aria-label="Список"
                    aria-pressed={view === "list"}
                    onClick={() => setView("list")}
                  >
                    <List size={18} />
                  </button>
                </div>
              </div>
              <div className="study-result-line">
                <span>
                  {query
                    ? `Результаты: ${filtered.length}`
                    : `${filtered.length} ${filtered.length === 1 ? "закладка" : filtered.length > 1 && filtered.length < 5 ? "закладки" : "закладок"}`}
                </span>
                {tag || domain ? (
                  <button
                    onClick={() => {
                      setTag("");
                      setDomain("");
                    }}
                  >
                    <Hash size={12} />
                    {tag || domain}
                    <X size={12} />
                  </button>
                ) : (
                  <span>
                    Сначала новые <ChevronDown size={12} />
                  </span>
                )}
              </div>
              {filtered.length === 0 ? (
                <div className="study-empty">
                  <Bookmark size={32} strokeWidth={1.2} />
                  <h2>Ничего не нашлось</h2>
                  <p>Попробуйте другой запрос или уберите фильтры.</p>
                  <button
                    className="study-button"
                    onClick={() => {
                      navigate("Все закладки");
                      setQuery("");
                    }}
                  >
                    Показать все закладки
                  </button>
                </div>
              ) : (
                <div className={`study-bookmarks study-bookmarks--${view}`}>
                  {filtered.map((b) => (
                    <article
                      key={b.id}
                      className="study-bookmark"
                      data-bookmark-id={b.id}
                    >
                      <a
                        className="study-preview-link"
                        href={b.url}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`Открыть: ${b.title}`}
                      >
                        <Preview kind={b.preview} />
                      </a>
                      <div className="study-card-body">
                        <div className="study-card-source">
                          <span className="study-site-mark">
                            {b.domain[0].toUpperCase()}
                          </span>
                          <span>{b.domain}</span>
                          <button
                            className={`study-icon favorite ${b.favorite ? "is-favorite" : ""}`}
                            onClick={() => toggleFavorite(b.id)}
                            aria-label={
                              b.favorite
                                ? "Убрать из избранного"
                                : "В избранное"
                            }
                            aria-pressed={b.favorite}
                          >
                            <Heart size={15} />
                          </button>
                        </div>
                        <h2>
                          <a href={b.url} target="_blank" rel="noreferrer">
                            {b.title}
                          </a>
                        </h2>
                        <p className="study-description">
                          {b.description ||
                            "Описание появится после получения информации о странице."}
                        </p>
                        <div className="study-card-tags">
                          {b.tags.slice(0, 2).map((t) => (
                            <button key={t} onClick={() => setTag(t)}>
                              #{t}
                            </button>
                          ))}
                        </div>
                        <footer>
                          <span>{b.collection || "Без коллекции"}</span>
                          <time>{b.date}</time>
                          <details className="study-card-menu">
                            <summary aria-label={`Действия: ${b.title}`}>
                              <MoreHorizontal size={18} />
                            </summary>
                            <div>
                              <button
                                onClick={() => {
                                  setEditing({ ...b });
                                }}
                              >
                                <Settings2 size={14} />
                                Редактировать
                              </button>
                              <button
                                onClick={() => {
                                  void copy(b.url);
                                }}
                              >
                                <Copy size={14} />
                                Копировать ссылку
                              </button>
                              <button
                                className="danger"
                                onClick={() => {
                                  setDeleting(b);
                                  openSurface("delete");
                                }}
                              >
                                <X size={14} />
                                Удалить
                              </button>
                            </div>
                          </details>
                        </footer>
                      </div>
                    </article>
                  ))}
                </div>
              )}
              <div className="study-bottom-note">
                <span>Ваша библиотека. На вашем компьютере.</span>
                <span>Демонстрационные данные</span>
              </div>
            </div>
          </main>
        </div>
      </div>

      {notice && (
        <div className="study-toast" role="status">
          <Check size={16} />
          {notice}
        </div>
      )}
      {surface && (
        <StudyDialog
          title={
            {
              add: "Добавить ссылку",
              import: "Импорт закладок",
              connect: "Подключить браузер",
              settings: "Настройки",
              delete: "Удалить закладку?",
              collection: "Новая коллекция",
            }[surface]
          }
          close={() => setSurface(null)}
        >
          {surface === "add" && (
            <form onSubmit={add} className="study-form">
              <p className="study-muted">
                Хорошая находка заслуживает места в библиотеке.
              </p>
              <label>
                Ссылка
                <input
                  autoFocus
                  type="url"
                  required
                  placeholder="https://"
                  value={draftUrl}
                  onChange={(e) => setDraftUrl(e.target.value)}
                />
              </label>
              <label>
                Название
                <input
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  placeholder="Необязательно"
                />
              </label>
              <div className="study-form-row">
                <label>
                  Коллекция
                  <select
                    value={draftCollection}
                    onChange={(e) => setDraftCollection(e.target.value)}
                  >
                    <option value="">Без коллекции</option>
                    {collections.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Теги
                  <input
                    value={draftTags}
                    onChange={(e) => setDraftTags(e.target.value)}
                    placeholder="Через запятую"
                  />
                </label>
              </div>
              {error && (
                <p className="study-error" role="alert">
                  {error}
                </p>
              )}
              <footer>
                <button
                  type="button"
                  className="study-button"
                  onClick={() => setSurface(null)}
                >
                  Отмена
                </button>
                <button className="study-button primary" type="submit">
                  Сохранить ссылку
                </button>
              </footer>
            </form>
          )}
          {surface === "import" && (
            <div className="study-form">
              <p className="study-muted">
                Выберите HTML-файл экспорта из Chrome, Edge или Firefox. В
                концепте импорт добавляет ссылки только в демонстрационный
                список.
              </p>
              <label className="study-file-label">
                <ArrowDownToLine size={24} />
                <span>Файл закладок .html</span>
                <input
                  type="file"
                  accept=".html,.htm"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) setImportContent(await file.text());
                  }}
                />
              </label>
              {error && (
                <p className="study-error" role="alert">
                  {error}
                </p>
              )}
              <footer>
                <button
                  className="study-button primary"
                  disabled={!importContent}
                  onClick={doImport}
                >
                  Импортировать
                </button>
              </footer>
            </div>
          )}
          {surface === "connect" && (
            <div className="study-form">
              <div className="study-connect-icon">
                <Link size={24} />
              </div>
              <h3>Из браузера — в библиотеку</h3>
              <p className="study-muted">
                Будущее Chrome-расширение сохранит страницу одним нажатием. Если
                приложение закрыто, ссылка дождётся его в локальной очереди.
              </p>
              <ol className="study-steps">
                <li>Установите расширение OddClicks для Chrome.</li>
                <li>Соедините его с приложением локальным токеном.</li>
                <li>Нажмите значок на интересной странице.</li>
              </ol>
              <div className="study-inline-note">
                Экран подключения — часть концепта. Расширение будет доступно на
                следующем этапе.
              </div>
              <button
                className="study-button"
                onClick={() =>
                  setNotice(
                    "Букмарклет остаётся дополнительным способом сохранения",
                  )
                }
              >
                <Bookmark size={15} />
                Альтернативный способ: букмарклет
              </button>
            </div>
          )}
          {surface === "settings" && (
            <div className="study-form">
              <label>
                Тема
                <select
                  value={dark ? "dark" : "light"}
                  onChange={(e) => setDark(e.target.value === "dark")}
                >
                  <option value="light">Светлая</option>
                  <option value="dark">Тёмная</option>
                </select>
              </label>
              <label>
                Вид библиотеки
                <select
                  value={view}
                  onChange={(e) => setView(e.target.value as "grid" | "list")}
                >
                  <option value="grid">Сетка</option>
                  <option value="list">Список</option>
                </select>
              </label>
              <div className="study-inline-note">
                Настройки концепта действуют только в превью. Библиотека
                приложения остаётся прежней.
              </div>
            </div>
          )}
          {surface === "delete" && (
            <div className="study-form">
              <p>
                «{deleting?.title}» будет удалена из демонстрационного списка.
              </p>
              <footer>
                <button
                  className="study-button"
                  onClick={() => setSurface(null)}
                >
                  Оставить
                </button>
                <button
                  className="study-button destructive"
                  onClick={() => {
                    setBookmarks((prev) =>
                      prev.filter((b) => b.id !== deleting?.id),
                    );
                    setSurface(null);
                    setNotice("Закладка удалена из макета");
                  }}
                >
                  Удалить
                </button>
              </footer>
            </div>
          )}
          {surface === "collection" && (
            <form
              className="study-form"
              onSubmit={(e) => {
                e.preventDefault();
                const name = newCollection.trim();
                if (!name || collections.includes(name)) {
                  setError("Введите уникальное название");
                  return;
                }
                setCollections((prev) => [...prev, name]);
                setNewCollection("");
                setSurface(null);
              }}
            >
              <label>
                Название
                <input
                  autoFocus
                  required
                  value={newCollection}
                  onChange={(e) => setNewCollection(e.target.value)}
                  placeholder="Например, следующий проект"
                />
              </label>
              {error && (
                <p className="study-error" role="alert">
                  {error}
                </p>
              )}
              <footer>
                <button className="study-button primary" type="submit">
                  Создать коллекцию
                </button>
              </footer>
            </form>
          )}
        </StudyDialog>
      )}

      {editing && (
        <dialog
          ref={editDialog}
          className="study-editor"
          onCancel={() => setEditing(null)}
        >
          <header>
            <span className="study-eyebrow">Закладка</span>
            <button
              className="study-icon"
              aria-label="Закрыть редактор"
              onClick={() => setEditing(null)}
            >
              <X size={18} />
            </button>
          </header>
          <Preview kind={editing.preview} />
          <form
            className="study-form"
            onSubmit={(e) => {
              e.preventDefault();
              setBookmarks((prev) =>
                prev.map((b) => (b.id === editing.id ? editing : b)),
              );
              setEditing(null);
              setNotice("Изменения сохранены в макете");
            }}
          >
            <label>
              Название
              <input
                autoFocus
                required
                value={editing.title}
                onChange={(e) =>
                  setEditing({ ...editing, title: e.target.value })
                }
              />
            </label>
            <label>
              Коллекция
              <select
                value={editing.collection}
                onChange={(e) =>
                  setEditing({ ...editing, collection: e.target.value })
                }
              >
                <option value="">Без коллекции</option>
                {collections.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label>
              Теги
              <input
                value={editing.tags.join(", ")}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    tags: e.target.value.split(",").map((t) => t.trim()),
                  })
                }
              />
            </label>
            <label>
              Заметка
              <textarea
                rows={4}
                value={editing.notes}
                onChange={(e) =>
                  setEditing({ ...editing, notes: e.target.value })
                }
                placeholder="Что хочется запомнить?"
              />
            </label>
            <a
              className="study-editor-url"
              href={editing.url}
              target="_blank"
              rel="noreferrer"
            >
              {editing.domain}
              <ArrowUpRight size={14} />
            </a>
            <footer>
              <button className="study-button primary" type="submit">
                Сохранить изменения
              </button>
            </footer>
          </form>
        </dialog>
      )}
    </div>
  );
}
