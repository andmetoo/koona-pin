import React, { useState, useEffect, useCallback } from "react";
import { TitleBar } from "./components/TitleBar";
import { Navbar } from "./components/Navbar";
import { Sidebar } from "./components/Sidebar";
import { BookmarkCard } from "./components/BookmarkCard";
import { BookmarkRow } from "./components/BookmarkRow";
import { QuickAddModal } from "./components/QuickAddModal";
import { BookmarkletModal } from "./components/BookmarkletModal";
import { ImportModal } from "./components/ImportModal";
import { EditModal } from "./components/EditModal";
import { Bookmark, Collection, Tag, DomainCount, FilterState, ViewMode } from "./types";
import { api } from "./services/api";
import { Bookmark as BookmarkIcon, Plus, Sparkles, FilterX } from "lucide-react";

export const App: React.FC = () => {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [domains, setDomains] = useState<DomainCount[]>([]);

  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [filters, setFilters] = useState<FilterState>({
    search: "",
    collectionId: null,
    tag: null,
    domain: null,
    onlyFavorites: false,
  });

  const [isQuickAddOpen, setIsQuickAddOpen] = useState(false);
  const [isBookmarkletOpen, setIsBookmarkletOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [editingBookmark, setEditingBookmark] = useState<Bookmark | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [bList, cList, tList, dList] = await Promise.all([
        api.getBookmarks(filters),
        api.getCollections(),
        api.getTags(),
        api.getDomains(),
      ]);
      setBookmarks(bList);
      setCollections(cList);
      setTags(tList);
      setDomains(dList);
    } catch (err) {
      console.error("Failed to load bookmarks:", err);
    }
  }, [filters]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Realtime listener for incoming bookmarks from local Webhook / Bookmarklet
  useEffect(() => {
    const unsubscribe = api.onBookmarkAdded((newBookmark) => {
      setBookmarks((prev) => [newBookmark, ...prev.filter((b) => b.id !== newBookmark.id)]);
      api.getDomains().then(setDomains);
      api.getTags().then(setTags);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  const handleFilterChange = (partial: Partial<FilterState>) => {
    setFilters((prev) => ({ ...prev, ...partial }));
  };

  const handleOpenUrl = (url: string) => {
    api.openUrl(url);
  };

  const handleToggleFavorite = async (id: number, current: boolean) => {
    try {
      await api.updateBookmark(id, { is_favorite: !current });
      setBookmarks((prev) =>
        prev.map((b) => (b.id === id ? { ...b, is_favorite: !current } : b))
      );
    } catch (err) {
      console.error(err);
    }
  };

  const handleDeleteBookmark = async (id: number) => {
    try {
      await api.deleteBookmark(id);
      setBookmarks((prev) => prev.filter((b) => b.id !== id));
      api.getDomains().then(setDomains);
      api.getTags().then(setTags);
    } catch (err) {
      console.error(err);
    }
  };

  const handleCreateCollection = async (name: string, color?: string) => {
    try {
      const newCol = await api.createCollection(name, color);
      setCollections((prev) => [...prev, newCol]);
    } catch (err) {
      console.error(err);
    }
  };

  const handleDeleteCollection = async (id: number) => {
    try {
      await api.deleteCollection(id);
      setCollections((prev) => prev.filter((c) => c.id !== id));
      if (filters.collectionId === id) {
        handleFilterChange({ collectionId: null });
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleQuickAdd = async (data: {
    url: string;
    title?: string;
    collectionId?: number | null;
    tags?: string[];
  }) => {
    const created = await api.addBookmark(data);
    setBookmarks((prev) => [created, ...prev]);
    loadData();
  };

  const handleImportBookmarks = async (content: string) => {
    const count = await api.importHtmlBookmarks(content);
    await loadData();
    return count;
  };

  const handleSaveEdit = async (
    id: number,
    data: {
      title?: string;
      notes?: string;
      is_favorite?: boolean;
      collection_id?: number | null;
      tags?: string[];
    }
  ) => {
    try {
      const updated = await api.updateBookmark(id, data);
      setBookmarks((prev) => prev.map((b) => (b.id === id ? updated : b)));
      loadData();
    } catch (err) {
      console.error(err);
    }
  };

  const totalFavorites = bookmarks.filter((b) => b.is_favorite).length;

  return (
    <div className="h-screen w-screen flex flex-col bg-background text-slate-100 overflow-hidden font-sans">
      {/* Windows 11 TitleBar */}
      <TitleBar />

      {/* Top Navbar */}
      <Navbar
        search={filters.search}
        onSearchChange={(search) => handleFilterChange({ search })}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onOpenQuickAdd={() => setIsQuickAddOpen(true)}
        onOpenBookmarklet={() => setIsBookmarkletOpen(true)}
        onOpenImport={() => setIsImportOpen(true)}
        totalCount={bookmarks.length}
      />

      {/* Main Workspace (Sidebar + Content) */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <Sidebar
          filters={filters}
          onFilterChange={handleFilterChange}
          collections={collections}
          tags={tags}
          domains={domains}
          onCreateCollection={handleCreateCollection}
          onDeleteCollection={handleDeleteCollection}
          totalCount={bookmarks.length}
          favoritesCount={totalFavorites}
        />

        {/* Content Area */}
        <main className="flex-1 overflow-y-auto p-6 relative">
          {/* Active Filter Chips bar (if any filter active) */}
          {(filters.tag || filters.domain || filters.collectionId || filters.onlyFavorites) && (
            <div className="mb-4 flex items-center space-x-2">
              <span className="text-xs text-slate-400">Фильтр:</span>
              {filters.onlyFavorites && (
                <span className="text-xs px-2.5 py-1 rounded-lg bg-amber-500/20 text-amber-300 border border-amber-500/30 flex items-center space-x-1">
                  <span>Избранное</span>
                </span>
              )}
              {filters.collectionId && (
                <span className="text-xs px-2.5 py-1 rounded-lg bg-brand-600/20 text-brand-300 border border-brand-500/30 flex items-center space-x-1">
                  <span>Коллекция: {collections.find((c) => c.id === filters.collectionId)?.name}</span>
                </span>
              )}
              {filters.tag && (
                <span className="text-xs px-2.5 py-1 rounded-lg bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 flex items-center space-x-1">
                  <span>#{filters.tag}</span>
                </span>
              )}
              {filters.domain && (
                <span className="text-xs px-2.5 py-1 rounded-lg bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 flex items-center space-x-1">
                  <span>{filters.domain}</span>
                </span>
              )}
              <button
                onClick={() =>
                  handleFilterChange({
                    tag: null,
                    domain: null,
                    collectionId: null,
                    onlyFavorites: false,
                  })
                }
                className="text-xs text-slate-400 hover:text-white p-1 hover:bg-surface-200 rounded-lg flex items-center space-x-1"
                title="Сбросить фильтры"
              >
                <FilterX className="w-3.5 h-3.5" />
                <span>Сбросить</span>
              </button>
            </div>
          )}

          {/* Bookmarks List / Grid or Empty State */}
          {bookmarks.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center p-8 space-y-4">
              <div className="w-16 h-16 rounded-2xl bg-surface-200/60 border border-white/10 flex items-center justify-center text-brand-400 shadow-xl">
                <BookmarkIcon className="w-8 h-8 opacity-80" />
              </div>
              <div className="max-w-md space-y-1.5">
                <h3 className="text-lg font-semibold text-white">Здесь пока нет закладок</h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Добавьте первую ссылку вручную или настройте 1-Click букмарклет в браузере, чтобы захватывать страницы отовсюду.
                </p>
              </div>
              <div className="flex items-center space-x-3 pt-2">
                <button
                  onClick={() => setIsQuickAddOpen(true)}
                  className="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-500 text-white text-xs font-semibold flex items-center space-x-2 transition-all shadow-glow"
                >
                  <Plus className="w-4 h-4" />
                  <span>Добавить ссылку</span>
                </button>
                <button
                  onClick={() => setIsBookmarkletOpen(true)}
                  className="px-4 py-2 rounded-xl bg-surface-200 hover:bg-surface-300 text-indigo-300 hover:text-white text-xs font-semibold flex items-center space-x-2 transition-colors border border-brand-500/20"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Настроить букмарклет</span>
                </button>
              </div>
            </div>
          ) : viewMode === "grid" ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 pb-12">
              {bookmarks.map((b) => (
                <BookmarkCard
                  key={b.id}
                  bookmark={b}
                  collections={collections}
                  onOpen={handleOpenUrl}
                  onToggleFavorite={handleToggleFavorite}
                  onDelete={handleDeleteBookmark}
                  onEdit={(bm) => setEditingBookmark(bm)}
                  onSelectTag={(t) => handleFilterChange({ tag: t })}
                />
              ))}
            </div>
          ) : (
            <div className="space-y-2 pb-12 max-w-5xl mx-auto">
              {bookmarks.map((b) => (
                <BookmarkRow
                  key={b.id}
                  bookmark={b}
                  collections={collections}
                  onOpen={handleOpenUrl}
                  onToggleFavorite={handleToggleFavorite}
                  onDelete={handleDeleteBookmark}
                  onEdit={(bm) => setEditingBookmark(bm)}
                  onSelectTag={(t) => handleFilterChange({ tag: t })}
                />
              ))}
            </div>
          )}
        </main>
      </div>

      {/* Modals */}
      <QuickAddModal
        isOpen={isQuickAddOpen}
        onClose={() => setIsQuickAddOpen(false)}
        collections={collections}
        onAddBookmark={handleQuickAdd}
      />

      <BookmarkletModal
        isOpen={isBookmarkletOpen}
        onClose={() => setIsBookmarkletOpen(false)}
      />

      <ImportModal
        isOpen={isImportOpen}
        onClose={() => setIsImportOpen(false)}
        onImport={handleImportBookmarks}
      />

      <EditModal
        bookmark={editingBookmark}
        collections={collections}
        isOpen={editingBookmark !== null}
        onClose={() => setEditingBookmark(null)}
        onSave={handleSaveEdit}
        onDelete={handleDeleteBookmark}
      />
    </div>
  );
};
