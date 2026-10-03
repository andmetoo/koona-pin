import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpRight,
  Bookmark as BookmarkIcon,
  Check,
  ChevronDown,
  Copy,
  Folder,
  Globe,
  Grid2X2,
  Heart,
  Link,
  List,
  Plus,
  Search,
  Settings2,
  X,
} from "lucide-react";
import { api, isTauri } from "./services/api";
import {
  AppSettings,
  Bookmark,
  FilterState,
  ServerStatus,
  ViewMode,
} from "./types";
import { useLibrary } from "./hooks/useLibrary";
import { LibraryCard } from "./components/ui/LibraryCard";
import { Dialog } from "./components/ui/Dialog";
import { WindowBar } from "./components/ui/WindowBar";
import { BookmarkEditor } from "./components/ui/BookmarkEditor";

type Surface = "add" | "import" | "connect" | "settings" | "collection" | null;
type Theme = "light" | "dark" | "system";
const initialFilters: FilterState = {
  search: "",
  collectionId: null,
  tag: null,
  domain: null,
  onlyFavorites: false,
};
function preference<T extends string>(
  name: string,
  allowed: T[],
  fallback: T,
): T {
  try {
    // Values saved by OddClicks are read until the new key is written.
    for (const key of [`netamipin.${name}`, `oddclicks.${name}`]) {
      const v = localStorage.getItem(key);
      if (allowed.includes(v as T)) return v as T;
    }
  } catch {
    /* Storage unavailable: use the default. */
  }
  return fallback;
}
const bookmarklet =
  "javascript:(function(){const u=encodeURIComponent(location.href),t=encodeURIComponent(document.title);fetch('http://127.0.0.1:28765/api/add?url='+u+'&title='+t,{mode:'no-cors'}).then(()=>{const n=document.createElement('div');n.textContent='Netami Pin: отправлено';n.style='position:fixed;top:20px;right:20px;z-index:2147483647;background:#a34f34;color:#fff;padding:12px 18px;border-radius:5px;font:14px sans-serif';document.body.append(n);setTimeout(()=>n.remove(),2500)}).catch(()=>{const n=document.createElement('div');n.textContent='Запустите Netami Pin и повторите';n.style='position:fixed;top:20px;right:20px;z-index:2147483647;background:#333;color:#fff;padding:12px;font:14px sans-serif';document.body.append(n);setTimeout(()=>n.remove(),3000)})})();";

export function App() {
  const [theme, setTheme] = useState<Theme>(() =>
    preference("theme", ["light", "dark", "system"], "system"),
  );
  const [systemDark, setSystemDark] = useState(
    matchMedia("(prefers-color-scheme:dark)").matches,
  );
  const [wide, setWide] = useState(matchMedia("(min-width:1150px)").matches);
  const [view, setView] = useState<ViewMode>(() =>
    preference("view", ["grid", "list"], "grid"),
  );
  const [filters, setFilters] = useState(initialFilters);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const library = useLibrary(filters, scrollRef);
  const [surface, setSurface] = useState<Surface>(null);
  const [editing, setEditing] = useState<Bookmark | null>(null);
  const [deleting, setDeleting] = useState<Bookmark | null>(null);
  const [deleteCollection, setDeleteCollection] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [collectionId, setCollectionId] = useState<number | null>(null);
  const [tagInput, setTagInput] = useState("");
  const [collectionName, setCollectionName] = useState("");
  const [importContent, setImportContent] = useState("");
  const [importName, setImportName] = useState("");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [server, setServer] = useState<ServerStatus | null>(null);
  const [bookmarkletOpen, setBookmarkletOpen] = useState(false);
  const [legacyWarning, setLegacyWarning] = useState("");
  const editorFocus = useRef<HTMLElement | null>(null);
  const dark = theme === "dark" || (theme === "system" && systemDark);
  useEffect(() => {
    document.documentElement.dataset.studyTheme = dark ? "dark" : "light";
    try {
      localStorage.setItem("netamipin.theme", theme);
    } catch {
      /* Preference remains available for this session. */
    }
  }, [theme, dark]);
  useEffect(() => {
    try {
      localStorage.setItem("netamipin.view", view);
    } catch {
      /* Session only. */
    }
  }, [view]);
  useEffect(() => {
    const color = matchMedia("(prefers-color-scheme:dark)");
    const width = matchMedia("(min-width:1150px)");
    const c = () => setSystemDark(color.matches);
    const w = () => setWide(width.matches);
    color.addEventListener("change", c);
    width.addEventListener("change", w);
    return () => {
      color.removeEventListener("change", c);
      width.removeEventListener("change", w);
    };
  }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === "Escape" && wide && editing) {
        setEditing(null);
        editorFocus.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [wide, editing]);
  useEffect(() => {
    if (!isTauri()) return;
    // The server thread reports a port conflict right after start.
    const timer = window.setTimeout(() => {
      void api
        .getServerStatus()
        .then((status) => {
          if (status.legacy_app) setLegacyWarning(status.error ?? "");
        })
        .catch(() => {});
    }, 1500);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!surface) return;
    setFormError("");
    setBusy(false);
    if (surface === "connect" || surface === "settings") {
      setSettings(null);
      setServer(null);
      Promise.all([api.getAppSettings(), api.getServerStatus()])
        .then(([s, status]) => {
          setSettings(s);
          setServer(status);
        })
        .catch((err) => setFormError(String(err)));
    }
    if (surface === "add") {
      setCollectionId(filters.collectionId);
    }
  }, [surface]);
  useEffect(() => {
    if (surface !== "connect") return;
    const timer = window.setInterval(() => {
      void api
        .getServerStatus()
        .then(setServer)
        .catch(() => {});
    }, 3000);
    return () => window.clearInterval(timer);
  }, [surface]);
  const changeFilters = (partial: Partial<FilterState>) => {
    scrollRef.current?.scrollTo({ top: 0 });
    setFilters((prev) => ({ ...prev, ...partial }));
  };
  const navigate = (collectionId: number | null, onlyFavorites = false) =>
    changeFilters({ collectionId, onlyFavorites, tag: null, domain: null });
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Скопировано");
    } catch {
      setNotice("Копирование недоступно. Выделите текст вручную.");
    }
  };
  const open = useCallback((url: string) => {
    void api.openUrl(url).catch((err) => setNotice(String(err)));
  }, []);
  const favorite = async (b: Bookmark) => {
    try {
      await api.updateBookmark(b.id, { is_favorite: !b.is_favorite });
    } catch (err) {
      setNotice(String(err));
    }
  };
  const edit = (b: Bookmark) => {
    editorFocus.current = document.activeElement as HTMLElement;
    setEditing(b);
  };
  const closeEditor = () => {
    setEditing(null);
    editorFocus.current?.focus();
  };
  const saveEdit = async (data: {
    title: string;
    notes: string;
    collection_id: number | null;
    tags: string[];
  }) => {
    if (!editing) return;
    await api.updateBookmark(editing.id, data);
    closeEditor();
    setNotice("Изменения сохранены");
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setFormError("");
    try {
      await fn();
    } catch (err) {
      setFormError(String(err));
    } finally {
      setBusy(false);
    }
  };
  const section = filters.onlyFavorites
    ? "Избранное"
    : filters.collectionId
      ? (library.collections.find((c) => c.id === filters.collectionId)?.name ??
        "Коллекция")
      : "Все закладки";
  const sectionCount = filters.onlyFavorites
    ? library.counts.favorites
    : filters.collectionId
      ? (library.collections.find((c) => c.id === filters.collectionId)
          ?.count ?? 0)
      : library.counts.total;
  const editor = editing && (
    <BookmarkEditor
      key={editing.id}
      bookmark={editing}
      collections={library.collections}
      onOpen={open}
      onSave={saveEdit}
    />
  );

  return (
    <div className="study-root study-editorial production">
      <div className="study-window">
        <WindowBar />
        <div className="study-workspace">
          <aside className="study-sidebar">
            <div className="study-sidebar-scroll">
              <div className="study-brand">
                <span className="study-logo">
                  <BookmarkIcon size={23} strokeWidth={1.6} />
                </span>
                <div>
                  Netami Pin<small>Место для хороших находок</small>
                </div>
              </div>
              <nav className="study-primary-nav" aria-label="Библиотека">
                <button
                  className={
                    !filters.collectionId && !filters.onlyFavorites
                      ? "active"
                      : ""
                  }
                  onClick={() => navigate(null)}
                >
                  <BookmarkIcon size={17} />
                  <span>Все закладки</span>
                  <small>{library.counts.total}</small>
                </button>
                <button
                  className={filters.onlyFavorites ? "active" : ""}
                  onClick={() => navigate(null, true)}
                >
                  <Heart size={17} />
                  <span>Избранное</span>
                  <small>{library.counts.favorites}</small>
                </button>
              </nav>
              <div className="study-section-label">
                <span>Коллекции</span>
                <button
                  className="study-icon"
                  aria-label="Новая коллекция"
                  onClick={() => setSurface("collection")}
                >
                  <Plus size={15} />
                </button>
              </div>
              <nav className="study-collection-nav" aria-label="Коллекции">
                {library.collections.map((c) => (
                  <div key={c.id} className="collection-item">
                    <button
                      className={filters.collectionId === c.id ? "active" : ""}
                      onClick={() => navigate(c.id)}
                    >
                      <Folder size={16} />
                      <span>{c.name}</span>
                      <small>{c.count ?? 0}</small>
                    </button>
                    <button
                      className="collection-delete"
                      aria-label={`Удалить коллекцию ${c.name}`}
                      onClick={() => {
                        setFormError("");
                        setDeleteCollection(c.id);
                      }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </nav>
              <details className="study-sidebar-details">
                <summary>
                  <span>Теги</span>
                  <ChevronDown size={14} />
                </summary>
                <div className="study-tag-cloud">
                  {library.tags.map((t) => (
                    <button
                      key={t.id}
                      className={filters.tag === t.name ? "selected" : ""}
                      onClick={() =>
                        changeFilters({
                          tag: filters.tag === t.name ? null : t.name,
                        })
                      }
                    >
                      #{t.name}
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
                  {library.domains.map((d) => (
                    <button
                      key={d.domain}
                      className={filters.domain === d.domain ? "active" : ""}
                      onClick={() =>
                        changeFilters({
                          domain: filters.domain === d.domain ? null : d.domain,
                        })
                      }
                    >
                      <Globe size={14} />
                      <span>{d.domain}</span>
                      <small>{d.count}</small>
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
              <button onClick={() => setSurface("connect")}>
                <Link size={16} />
                Подключить браузер
                <ArrowUpRight size={13} />
              </button>
              <button onClick={() => setSurface("settings")}>
                <Settings2 size={16} />
                Настройки
              </button>
            </footer>
          </aside>
          <main className="study-main">
            <div ref={scrollRef} className="study-main-scroll">
              <div className="study-heading-row">
                <div>
                  <p className="study-eyebrow">Личная библиотека</p>
                  <h1>
                    {section}
                    <span className="study-heading-count">{sectionCount}</span>
                  </h1>
                  <p className="study-subtitle">
                    Всё, что хочется сохранить. И легко найти снова.
                  </p>
                </div>
                <button
                  className="study-button primary"
                  onClick={() => setSurface("add")}
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
                    value={filters.search}
                    onChange={(e) => changeFilters({ search: e.target.value })}
                    aria-label="Поиск в библиотеке"
                    placeholder="Найти в библиотеке"
                  />
                  <kbd>Ctrl K</kbd>
                </label>
                <button
                  className="study-button quiet import-action"
                  onClick={() => setSurface("import")}
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
                <span aria-live="polite">
                  {library.loading
                    ? "Обновляется…"
                    : `Закладок: ${library.bookmarks.length}`}
                </span>
                <div className="active-filters">
                  {(filters.tag ||
                    filters.domain ||
                    filters.onlyFavorites ||
                    filters.collectionId) && (
                    <button
                      onClick={() =>
                        changeFilters({
                          ...initialFilters,
                          search: filters.search,
                        })
                      }
                    >
                      {filters.tag
                        ? `#${filters.tag}`
                        : filters.domain || section}
                      <X size={12} />
                    </button>
                  )}
                  {library.pendingCount > 0 && (
                    <button onClick={library.reveal}>
                      Новые закладки · {library.pendingCount}
                      <ChevronDown size={12} />
                    </button>
                  )}
                </div>
              </div>
              {library.error && (
                <div className="library-error" role="alert">
                  <span>{library.error}</span>
                  <button
                    className="study-button"
                    onClick={() => {
                      void library.refresh();
                      void library.refreshCatalog();
                    }}
                  >
                    Повторить
                  </button>
                </div>
              )}
              {library.bookmarks.length === 0 ? (
                library.loading ? (
                  <div className="study-loading" role="status">
                    Загружаем библиотеку…
                  </div>
                ) : (
                  <div className="study-empty">
                    <BookmarkIcon size={32} strokeWidth={1.2} />
                    <h2>
                      {library.counts.total
                        ? "Ничего не нашлось"
                        : "Здесь будет ваша библиотека"}
                    </h2>
                    <p>
                      {library.counts.total
                        ? "Попробуйте другой запрос или уберите фильтры."
                        : "Добавьте первую ссылку или подключите браузер."}
                    </p>
                    <button
                      className="study-button"
                      onClick={() =>
                        library.counts.total
                          ? changeFilters(initialFilters)
                          : setSurface("add")
                      }
                    >
                      {library.counts.total
                        ? "Показать все закладки"
                        : "Добавить ссылку"}
                    </button>
                  </div>
                )
              ) : (
                <div
                  className={`study-bookmarks study-bookmarks--${view} ${editing && wide ? "with-editor" : ""}`}
                  aria-busy={library.loading}
                >
                  {library.bookmarks.map((b) => (
                    <LibraryCard
                      key={b.id}
                      bookmark={b}
                      collections={library.collections}
                      onOpen={open}
                      onFavorite={(b) => {
                        void favorite(b);
                      }}
                      onEdit={edit}
                      onDelete={(b) => {
                        setFormError("");
                        setDeleting(b);
                      }}
                      onCopy={(text) => {
                        void copy(text);
                      }}
                      onTag={(tag) => changeFilters({ tag })}
                    />
                  ))}
                </div>
              )}
              <div className="study-bottom-note">
                <span>Ваша библиотека. На вашем компьютере.</span>
                {!isTauri() && <span>Демонстрационные данные</span>}
              </div>
            </div>
          </main>
          {editing && wide && (
            <aside className="editor-dock">
              <header>
                <h2>Закладка</h2>
                <button
                  className="study-icon"
                  aria-label="Закрыть редактор"
                  onClick={closeEditor}
                >
                  <X size={18} />
                </button>
              </header>
              {editor}
            </aside>
          )}
        </div>
      </div>
      {editing && !wide && (
        <Dialog title="Закладка" drawer onClose={closeEditor}>
          {editor}
        </Dialog>
      )}
      {legacyWarning && !notice && (
        <div className="study-toast" role="alert">
          {legacyWarning}
          <button
            className="study-button"
            onClick={() => setLegacyWarning("")}
          >
            Понятно
          </button>
        </div>
      )}
      {notice && (
        <div className="study-toast" role="status">
          <Check size={16} />
          {notice}
        </div>
      )}
      {surface && (
        <Dialog
          title={
            {
              add: "Добавить ссылку",
              import: "Импорт закладок",
              connect: "Подключить браузер",
              settings: "Настройки",
              collection: "Новая коллекция",
            }[surface]
          }
          onClose={() => {
            if (!busy) setSurface(null);
          }}
        >
          {surface === "add" && (
            <form
              className="study-form"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await api.addBookmark({
                    url: url.trim(),
                    title: title.trim() || undefined,
                    collectionId,
                    tags: tagInput
                      .split(",")
                      .map((t) => t.trim().toLowerCase())
                      .filter(Boolean),
                  });
                  scrollRef.current?.scrollTo({ top: 0 });
                  await library.refresh();
                  setSurface(null);
                  setUrl("");
                  setTitle("");
                  setTagInput("");
                  setNotice("Ссылка сохранена");
                });
              }}
            >
              <p className="study-muted">
                Хорошая находка заслуживает места в библиотеке.
              </p>
              <label>
                Ссылка
                <input
                  autoFocus
                  required
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://"
                />
              </label>
              <button
                className="study-button quiet clipboard-action"
                type="button"
                onClick={() => {
                  void navigator.clipboard
                    .readText()
                    .then((text) => setUrl(text.trim()))
                    .catch(() =>
                      setFormError(
                        "Буфер обмена недоступен. Вставьте ссылку вручную.",
                      ),
                    );
                }}
              >
                Вставить из буфера
              </button>
              <label>
                Название
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Необязательно"
                />
              </label>
              <div className="study-form-row">
                <label>
                  Коллекция
                  <select
                    aria-label="Коллекция"
                    value={collectionId ?? ""}
                    onChange={(e) =>
                      setCollectionId(
                        e.target.value ? Number(e.target.value) : null,
                      )
                    }
                  >
                    <option value="">Без коллекции</option>
                    {library.collections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Теги
                  <input
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    placeholder="Через запятую"
                  />
                </label>
              </div>
              <footer>
                <button className="study-button primary" disabled={busy}>
                  {busy ? "Сохраняется…" : "Сохранить ссылку"}
                </button>
              </footer>
            </form>
          )}
          {surface === "import" && (
            <div className="study-form">
              <p className="study-muted">
                Экспортируйте закладки из браузера в HTML и выберите файл.
                Повторяющиеся ссылки останутся в одном экземпляре.
              </p>
              <label className="study-file-label">
                <ArrowDownToLine size={24} />
                <span>{importName || "Файл закладок .html"}</span>
                <input
                  type="file"
                  accept=".html,.htm"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file)
                      void file
                        .text()
                        .then((content) => {
                          setImportContent(content);
                          setImportName(file.name);
                        })
                        .catch((err) => setFormError(String(err)));
                  }}
                />
              </label>
              <footer>
                <button
                  className="study-button primary"
                  disabled={busy || !importContent}
                  onClick={() => {
                    void run(async () => {
                      const count =
                        await api.importHtmlBookmarks(importContent);
                      await Promise.all([
                        library.refresh(),
                        library.refreshCatalog(),
                      ]);
                      setSurface(null);
                      setImportContent("");
                      setImportName("");
                      setNotice(`Новых ссылок: ${count}`);
                    });
                  }}
                >
                  {busy ? "Импортируется…" : "Импортировать"}
                </button>
              </footer>
            </div>
          )}
          {surface === "collection" && (
            <form
              className="study-form"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await api.createCollection(collectionName.trim());
                  await library.refreshCatalog();
                  setSurface(null);
                  setCollectionName("");
                });
              }}
            >
              <label>
                Название
                <input
                  autoFocus
                  required
                  value={collectionName}
                  onChange={(e) => setCollectionName(e.target.value)}
                  placeholder="Например, следующий проект"
                />
              </label>
              <footer>
                <button className="study-button primary" disabled={busy}>
                  Создать коллекцию
                </button>
              </footer>
            </form>
          )}
          {surface === "settings" && (
            <div className="study-form">
              <label>
                Тема
                <select
                  aria-label="Тема"
                  value={theme}
                  onChange={(e) => setTheme(e.target.value as Theme)}
                >
                  <option value="system">Как в системе</option>
                  <option value="light">Светлая</option>
                  <option value="dark">Тёмная</option>
                </select>
              </label>
              <label>
                Вид библиотеки
                <select
                  aria-label="Вид библиотеки"
                  value={view}
                  onChange={(e) => setView(e.target.value as ViewMode)}
                >
                  <option value="grid">Сетка</option>
                  <option value="list">Список</option>
                </select>
              </label>
              <label className="setting-checkbox">
                <input
                  type="checkbox"
                  disabled={!isTauri() || !settings || busy}
                  checked={settings?.close_to_tray ?? true}
                  onChange={(e) => {
                    const enabled = e.target.checked;
                    const previous = settings;
                    setSettings((prev) =>
                      prev ? { ...prev, close_to_tray: enabled } : prev,
                    );
                    void run(async () => {
                      try {
                        await api.setCloseToTray(enabled);
                      } catch (error) {
                        setSettings(previous);
                        throw error;
                      }
                    });
                  }}
                />
                <span>При закрытии окна оставлять приложение в трее</span>
              </label>
              <p className="study-muted">
                Полный выход — через меню значка Netami Pin в трее.
              </p>
              {!isTauri() && (
                <div className="study-inline-note">
                  Трей доступен в настольном приложении.
                </div>
              )}
            </div>
          )}
          {surface === "connect" && (
            <div className="study-form">
              <div className="study-connect-icon">
                <Link size={24} />
              </div>
              <h3>Из браузера — в библиотеку</h3>
              <div
                className={`connection-status ${server?.running ? "connected" : ""}`}
              >
                <span />
                {server?.running
                  ? "Приложение готово принимать ссылки"
                  : server?.error || "Проверяем подключение…"}
              </div>
              <p className="study-muted">
                Установите расширение из папки <code>extension/chrome</code>{" "}
                через «Загрузить распакованное расширение» в Chrome. Затем
                откройте его настройки.
              </p>
              {isTauri() ? (
                <label>
                  Локальный токен подключения
                  <div className="token-field">
                    <input
                      readOnly
                      type="password"
                      aria-label="Токен подключения"
                      value={settings?.capture_token ?? ""}
                    />
                    <button
                      className="study-icon"
                      aria-label="Скопировать токен"
                      disabled={!settings?.capture_token}
                      onClick={() => {
                        if (settings) void copy(settings.capture_token);
                      }}
                    >
                      <Copy size={16} />
                    </button>
                  </div>
                </label>
              ) : (
                <div className="study-inline-note">
                  Токен подключения доступен в настольном приложении Netami Pin.
                </div>
              )}
              <p className="study-muted">
                Когда приложение закрыто, расширение сохраняет ссылки в
                локальную очередь и передаёт их при следующем запуске.
              </p>
              <button
                className="study-button"
                onClick={() => setBookmarkletOpen(!bookmarkletOpen)}
              >
                <BookmarkIcon size={15} />
                Альтернативный способ: букмарклет
                <ChevronDown size={14} />
              </button>
              {bookmarkletOpen && (
                <div className="bookmarklet-section">
                  <p>
                    Перетащите кнопку на панель закладок браузера или скопируйте
                    код в адрес новой закладки.
                  </p>
                  <a
                    className="study-button primary"
                    ref={(element) => {
                      element?.setAttribute("href", bookmarklet);
                    }}
                    draggable
                    onClick={(e) => e.preventDefault()}
                  >
                    Сохранить в Netami Pin
                  </a>
                  <button
                    className="study-button"
                    onClick={() => {
                      void copy(bookmarklet);
                    }}
                  >
                    Копировать код
                  </button>
                  <small>
                    «Отправлено» означает отправку запроса; букмарклет не
                    проверяет результат записи. Ограничения браузера могут
                    блокировать доступ к локальному серверу.
                  </small>
                </div>
              )}
            </div>
          )}
          {formError && (
            <p className="study-error" role="alert">
              {formError}
            </p>
          )}
        </Dialog>
      )}
      {(deleting || deleteCollection !== null) && (
        <Dialog
          title={deleting ? "Удалить закладку?" : "Удалить коллекцию?"}
          onClose={() => {
            if (!busy) {
              setDeleting(null);
              setDeleteCollection(null);
            }
          }}
        >
          <div className="study-form">
            <p>
              {deleting
                ? `«${deleting.title}» будет удалена из библиотеки.`
                : "Закладки останутся в библиотеке без коллекции."}
            </p>
            {formError && (
              <p className="study-error" role="alert">
                {formError}
              </p>
            )}
            <footer>
              <button
                className="study-button"
                disabled={busy}
                onClick={() => {
                  setDeleting(null);
                  setDeleteCollection(null);
                }}
              >
                Оставить
              </button>
              <button
                className="study-button destructive"
                disabled={busy}
                onClick={() => {
                  void run(async () => {
                    if (deleting) {
                      await api.deleteBookmark(deleting.id);
                      if (editing?.id === deleting.id) closeEditor();
                    } else if (deleteCollection !== null) {
                      await api.deleteCollection(deleteCollection);
                      if (filters.collectionId === deleteCollection)
                        navigate(null);
                      await Promise.all([
                        library.refresh(),
                        library.refreshCatalog(),
                      ]);
                    }
                    setDeleting(null);
                    setDeleteCollection(null);
                    setNotice("Удалено");
                  });
                }}
              >
                Удалить
              </button>
            </footer>
          </div>
        </Dialog>
      )}
    </div>
  );
}
