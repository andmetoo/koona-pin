import React, { useEffect, useRef } from "react";
import { Search, LayoutGrid, List, Plus, Bookmark, Upload, X } from "lucide-react";
import { ViewMode } from "../types";

interface NavbarProps {
  search: string;
  onSearchChange: (search: string) => void;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  onOpenQuickAdd: () => void;
  onOpenBookmarklet: () => void;
  onOpenImport: () => void;
  totalCount: number;
}

export const Navbar: React.FC<NavbarProps> = ({
  search,
  onSearchChange,
  viewMode,
  onViewModeChange,
  onOpenQuickAdd,
  onOpenBookmarklet,
  onOpenImport,
  totalCount,
}) => {
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        onOpenQuickAdd();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onOpenQuickAdd]);

  return (
    <div className="h-16 px-6 border-b border-white/5 flex items-center justify-between gap-4 shrink-0 bg-surface-50/50 backdrop-blur-md">
      {/* Search Input */}
      <div className="relative flex-1 max-w-md">
        <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          ref={searchInputRef}
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Поиск по названию, ссылке, тегу... (Ctrl+K)"
          className="w-full h-10 pl-10 pr-16 bg-surface-100/90 hover:bg-surface-200/60 focus:bg-surface-200 border border-white/10 rounded-xl text-sm text-slate-100 placeholder-slate-400 focus:outline-none focus:border-brand-500 transition-all"
        />
        {search ? (
          <button
            onClick={() => onSearchChange("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white p-1"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        ) : (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-mono text-slate-400 border border-white/10 px-1.5 py-0.5 rounded bg-surface-200/50">
            Ctrl+K
          </span>
        )}
      </div>

      {/* Right Actions */}
      <div className="flex items-center space-x-2.5">
        {/* Count Pill */}
        <div className="hidden sm:flex items-center text-xs text-slate-400 px-3 py-1.5 rounded-lg bg-surface-100 border border-white/5">
          <span>Закладок: <strong className="text-slate-200 font-semibold">{totalCount}</strong></span>
        </div>

        {/* View Mode Toggle */}
        <div className="flex items-center bg-surface-100 border border-white/10 rounded-xl p-1">
          <button
            onClick={() => onViewModeChange("grid")}
            className={`p-1.5 rounded-lg transition-all ${
              viewMode === "grid"
                ? "bg-brand-600 text-white shadow-sm"
                : "text-slate-400 hover:text-slate-200"
            }`}
            title="Сетка карточек"
          >
            <LayoutGrid className="w-4 h-4" />
          </button>
          <button
            onClick={() => onViewModeChange("list")}
            className={`p-1.5 rounded-lg transition-all ${
              viewMode === "list"
                ? "bg-brand-600 text-white shadow-sm"
                : "text-slate-400 hover:text-slate-200"
            }`}
            title="Компактный список"
          >
            <List className="w-4 h-4" />
          </button>
        </div>

        {/* Import Button */}
        <button
          onClick={onOpenImport}
          className="h-10 px-3 rounded-xl bg-surface-100 hover:bg-surface-200 border border-white/10 text-slate-300 hover:text-white text-xs font-medium flex items-center space-x-1.5 transition-all"
          title="Импорт из HTML браузеров"
        >
          <Upload className="w-3.5 h-3.5 text-accent-cyan" />
          <span className="hidden md:inline">Импорт</span>
        </button>

        {/* Bookmarklet Button */}
        <button
          onClick={onOpenBookmarklet}
          className="h-10 px-3.5 rounded-xl bg-surface-100 hover:bg-surface-200 border border-brand-500/30 text-indigo-200 hover:text-white text-xs font-medium flex items-center space-x-2 transition-all shadow-sm"
          title="Настроить 1-Click захват из браузера"
        >
          <Bookmark className="w-3.5 h-3.5 text-brand-400" />
          <span className="hidden md:inline">Букмарклет</span>
        </button>

        {/* Quick Add Button */}
        <button
          onClick={onOpenQuickAdd}
          className="h-10 px-4 rounded-xl bg-gradient-to-r from-brand-600 to-indigo-600 hover:from-brand-500 hover:to-indigo-500 text-white text-xs font-semibold flex items-center space-x-2 transition-all shadow-glow hover:shadow-indigo-500/40"
        >
          <Plus className="w-4 h-4" />
          <span>Добавить</span>
        </button>
      </div>
    </div>
  );
};
