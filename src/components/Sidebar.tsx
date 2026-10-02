import React, { useState } from "react";
import {
  Star,
  FolderPlus,
  Hash,
  Globe,
  Trash2,
  Layers,
} from "lucide-react";
import { Collection, Tag, DomainCount, FilterState } from "../types";

interface SidebarProps {
  filters: FilterState;
  onFilterChange: (filters: Partial<FilterState>) => void;
  collections: Collection[];
  tags: Tag[];
  domains: DomainCount[];
  onCreateCollection: (name: string, color?: string) => Promise<void>;
  onDeleteCollection: (id: number) => Promise<void>;
  totalCount: number;
  favoritesCount: number;
}

export const Sidebar: React.FC<SidebarProps> = ({
  filters,
  onFilterChange,
  collections,
  tags,
  domains,
  onCreateCollection,
  onDeleteCollection,
  totalCount,
  favoritesCount,
}) => {
  const [showAddCollection, setShowAddCollection] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [selectedColor, setSelectedColor] = useState("#6366f1");

  const colors = ["#6366f1", "#ec4899", "#10b981", "#f59e0b", "#06b6d4", "#8b5cf6"];

  const handleAddCollectionSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCollectionName.trim()) return;
    await onCreateCollection(newCollectionName.trim(), selectedColor);
    setNewCollectionName("");
    setShowAddCollection(false);
  };

  const isAllSelected =
    !filters.onlyFavorites &&
    filters.collectionId === null &&
    filters.tag === null &&
    filters.domain === null;

  return (
    <aside className="w-64 border-r border-white/5 bg-surface-50/70 flex flex-col shrink-0 select-none overflow-hidden h-full">
      {/* Navigation Sections */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Core Navigation */}
        <div className="space-y-1">
          <button
            onClick={() =>
              onFilterChange({
                onlyFavorites: false,
                collectionId: null,
                tag: null,
                domain: null,
              })
            }
            className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium transition-all ${
              isAllSelected
                ? "bg-brand-600/20 text-brand-400 border border-brand-500/30"
                : "text-slate-300 hover:bg-surface-200/60 hover:text-white"
            }`}
          >
            <div className="flex items-center space-x-2.5">
              <Layers className="w-4 h-4 text-brand-400" />
              <span>Все закладки</span>
            </div>
            <span className="text-[11px] font-mono text-slate-400">{totalCount}</span>
          </button>

          <button
            onClick={() =>
              onFilterChange({
                onlyFavorites: true,
                collectionId: null,
                tag: null,
                domain: null,
              })
            }
            className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium transition-all ${
              filters.onlyFavorites
                ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                : "text-slate-300 hover:bg-surface-200/60 hover:text-white"
            }`}
          >
            <div className="flex items-center space-x-2.5">
              <Star className="w-4 h-4 text-amber-400 fill-amber-400/20" />
              <span>Избранное</span>
            </div>
            <span className="text-[11px] font-mono text-slate-400">{favoritesCount}</span>
          </button>
        </div>

        {/* Collections */}
        <div>
          <div className="flex items-center justify-between px-2 mb-2">
            <span className="text-[11px] font-semibold tracking-wider uppercase text-slate-400">
              Коллекции
            </span>
            <button
              onClick={() => setShowAddCollection(!showAddCollection)}
              className="p-1 rounded-md text-slate-400 hover:text-white hover:bg-surface-200 transition-colors"
              title="Создать коллекцию"
            >
              <FolderPlus className="w-3.5 h-3.5" />
            </button>
          </div>

          {showAddCollection && (
            <form
              onSubmit={handleAddCollectionSubmit}
              className="mb-2 p-2.5 bg-surface-200/80 rounded-xl border border-white/10 space-y-2.5 animate-in fade-in duration-200"
            >
              <input
                type="text"
                autoFocus
                value={newCollectionName}
                onChange={(e) => setNewCollectionName(e.target.value)}
                placeholder="Имя коллекции..."
                className="w-full text-xs px-2.5 py-1.5 bg-surface-100 rounded-lg border border-white/10 text-white placeholder-slate-400 focus:outline-none focus:border-brand-500"
              />
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-1.5">
                  {colors.map((c) => (
                    <button
                      type="button"
                      key={c}
                      onClick={() => setSelectedColor(c)}
                      className={`w-4 h-4 rounded-full transition-transform ${
                        selectedColor === c ? "scale-125 ring-2 ring-white/50" : "opacity-70 hover:opacity-100"
                      }`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
                <div className="flex space-x-1">
                  <button
                    type="submit"
                    className="px-2 py-1 bg-brand-600 hover:bg-brand-500 text-white text-[11px] font-medium rounded-md"
                  >
                    Создать
                  </button>
                </div>
              </div>
            </form>
          )}

          <div className="space-y-0.5">
            {collections.map((col) => {
              const isSelected = filters.collectionId === col.id;
              return (
                <div
                  key={col.id}
                  className={`group flex items-center justify-between px-3 py-1.5 rounded-xl text-xs transition-all ${
                    isSelected
                      ? "bg-surface-200 text-white font-medium border border-white/10"
                      : "text-slate-400 hover:bg-surface-200/40 hover:text-slate-200"
                  }`}
                >
                  <button
                    onClick={() =>
                      onFilterChange({
                        collectionId: isSelected ? null : col.id,
                        tag: null,
                        domain: null,
                        onlyFavorites: false,
                      })
                    }
                    className="flex-1 flex items-center space-x-2.5 text-left truncate"
                  >
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: col.color || "#6366f1" }}
                    />
                    <span className="truncate">{col.name}</span>
                  </button>
                  <div className="flex items-center space-x-1">
                    {col.count !== undefined && col.count > 0 && (
                      <span className="text-[10px] font-mono text-slate-400 group-hover:hidden">
                        {col.count}
                      </span>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Удалить коллекцию «${col.name}»?`)) {
                          onDeleteCollection(col.id);
                        }
                      }}
                      className="hidden group-hover:flex p-1 text-slate-400 hover:text-rose-400 transition-colors"
                      title="Удалить"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Domains */}
        {domains.length > 0 && (
          <div>
            <div className="flex items-center px-2 mb-2">
              <span className="text-[11px] font-semibold tracking-wider uppercase text-slate-400">
                Домены
              </span>
            </div>
            <div className="space-y-0.5 max-h-48 overflow-y-auto">
              {domains.slice(0, 10).map((d) => {
                const isSelected = filters.domain === d.domain;
                return (
                  <button
                    key={d.domain}
                    onClick={() =>
                      onFilterChange({
                        domain: isSelected ? null : d.domain,
                        tag: null,
                        collectionId: null,
                        onlyFavorites: false,
                      })
                    }
                    className={`w-full flex items-center justify-between px-3 py-1.5 rounded-xl text-xs transition-all ${
                      isSelected
                        ? "bg-surface-200 text-white font-medium border border-white/10"
                        : "text-slate-400 hover:bg-surface-200/40 hover:text-slate-200"
                    }`}
                  >
                    <div className="flex items-center space-x-2 truncate">
                      <Globe className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <span className="truncate">{d.domain}</span>
                    </div>
                    <span className="text-[10px] font-mono text-slate-400 shrink-0">
                      {d.count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Tags */}
        {tags.length > 0 && (
          <div>
            <div className="flex items-center px-2 mb-2">
              <span className="text-[11px] font-semibold tracking-wider uppercase text-slate-400">
                Теги
              </span>
            </div>
            <div className="flex flex-wrap gap-1 px-1">
              {tags.map((t) => {
                const isSelected = filters.tag === t.name;
                return (
                  <button
                    key={t.name}
                    onClick={() =>
                      onFilterChange({
                        tag: isSelected ? null : t.name,
                        domain: null,
                        collectionId: null,
                        onlyFavorites: false,
                      })
                    }
                    className={`px-2 py-1 rounded-lg text-[11px] font-medium transition-all flex items-center space-x-1 ${
                      isSelected
                        ? "bg-brand-600 text-white"
                        : "bg-surface-200/70 text-slate-300 hover:bg-surface-200 hover:text-white"
                    }`}
                  >
                    <Hash className="w-2.5 h-2.5 opacity-60" />
                    <span>{t.name}</span>
                    {t.count !== undefined && (
                      <span className="text-[9px] opacity-70">({t.count})</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Webhook Status Pill in Footer */}
      <div className="p-3 border-t border-white/5 bg-surface-100/40 flex items-center justify-between text-[11px] text-slate-400">
        <div className="flex items-center space-x-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
          </span>
          <span>Сервер :28765</span>
        </div>
        <span className="font-mono text-[10px] text-emerald-400/90 font-medium">Активен</span>
      </div>
    </aside>
  );
};
