import React, { useState } from "react";
import {
  ExternalLink,
  Star,
  Copy,
  Check,
  Trash2,
  Edit2,
  Globe,
} from "lucide-react";
import { Bookmark, Collection } from "../types";

interface BookmarkRowProps {
  bookmark: Bookmark;
  collections: Collection[];
  onOpen: (url: string) => void;
  onToggleFavorite: (id: number, current: boolean) => void;
  onDelete: (id: number) => void;
  onEdit: (bookmark: Bookmark) => void;
  onSelectTag?: (tag: string) => void;
}

export const BookmarkRow: React.FC<BookmarkRowProps> = ({
  bookmark,
  collections,
  onOpen,
  onToggleFavorite,
  onDelete,
  onEdit,
  onSelectTag,
}) => {
  const [copied, setCopied] = useState(false);
  const collection = collections.find((c) => c.id === bookmark.collection_id);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(bookmark.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const formattedDate = new Date(bookmark.created_at).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "short",
  });

  return (
    <div
      onClick={() => onOpen(bookmark.url)}
      className="glass-card px-4 py-3 rounded-xl flex items-center justify-between gap-4 group cursor-pointer border border-white/5 hover:border-brand-500/30 transition-all"
    >
      {/* Left: Favicon & Info */}
      <div className="flex items-center space-x-3.5 min-w-0 flex-1">
        {/* Favicon */}
        <div className="w-8 h-8 rounded-lg bg-surface-200/80 flex items-center justify-center shrink-0 border border-white/5">
          {bookmark.favicon_url ? (
            <img
              src={bookmark.favicon_url}
              alt=""
              className="w-4 h-4 rounded-sm"
              onError={(e) => {
                (e.target as HTMLElement).style.display = "none";
              }}
            />
          ) : (
            <Globe className="w-4 h-4 text-slate-400" />
          )}
        </div>

        {/* Title & Domain */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center space-x-2">
            <h4 className="text-xs font-semibold text-slate-100 group-hover:text-brand-400 transition-colors truncate">
              {bookmark.title || bookmark.url}
            </h4>
            {collection && (
              <span
                className="text-[10px] px-1.5 py-0.2 rounded-md font-medium shrink-0"
                style={{
                  backgroundColor: `${collection.color || "#6366f1"}25`,
                  color: collection.color || "#6366f1",
                }}
              >
                {collection.name}
              </span>
            )}
          </div>
          <div className="flex items-center space-x-2 mt-0.5">
            <span className="text-[11px] font-mono text-slate-400 truncate">
              {bookmark.domain}
            </span>
            {bookmark.tags && bookmark.tags.length > 0 && (
              <div className="flex items-center space-x-1">
                <span className="text-slate-600">•</span>
                {bookmark.tags.slice(0, 2).map((tag) => (
                  <span
                    key={tag}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectTag?.(tag);
                    }}
                    className="text-[10px] text-slate-400 hover:text-brand-400"
                  >
                    #{tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right: Date & Actions */}
      <div className="flex items-center space-x-3 shrink-0">
        <span className="text-[11px] text-slate-400 font-mono hidden md:inline">
          {formattedDate}
        </span>

        {/* Favorite */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite(bookmark.id, bookmark.is_favorite);
          }}
          className={`p-1.5 rounded-lg transition-colors ${
            bookmark.is_favorite
              ? "text-amber-400"
              : "text-slate-400 hover:text-white"
          }`}
          title={bookmark.is_favorite ? "Убрать из избранного" : "В избранное"}
        >
          <Star
            className={`w-3.5 h-3.5 ${
              bookmark.is_favorite ? "fill-amber-400" : ""
            }`}
          />
        </button>

        {/* Action icons */}
        <div className="flex items-center space-x-1 opacity-60 group-hover:opacity-100 transition-opacity">
          <button
            onClick={handleCopy}
            className="p-1.5 rounded-lg hover:bg-surface-200 text-slate-400 hover:text-white transition-colors"
            title="Скопировать"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onEdit(bookmark);
            }}
            className="p-1.5 rounded-lg hover:bg-surface-200 text-slate-400 hover:text-white transition-colors"
            title="Редактировать"
          >
            <Edit2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (confirm("Удалить закладку?")) {
                onDelete(bookmark.id);
              }
            }}
            className="p-1.5 rounded-lg hover:bg-surface-200 text-slate-400 hover:text-rose-400 transition-colors"
            title="Удалить"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onOpen(bookmark.url);
            }}
            className="p-1.5 rounded-lg hover:bg-surface-200 text-slate-400 hover:text-white transition-colors"
            title="Открыть в браузере"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
};
