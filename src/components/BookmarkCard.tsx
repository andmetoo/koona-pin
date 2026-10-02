import React, { useState } from "react";
import {
  ExternalLink,
  Star,
  Copy,
  Check,
  Trash2,
  Edit2,
  Globe,
  Clock,
} from "lucide-react";
import { Bookmark, Collection } from "../types";

interface BookmarkCardProps {
  bookmark: Bookmark;
  collections: Collection[];
  onOpen: (url: string) => void;
  onToggleFavorite: (id: number, current: boolean) => void;
  onDelete: (id: number) => void;
  onEdit: (bookmark: Bookmark) => void;
  onSelectTag?: (tag: string) => void;
}

export const BookmarkCard: React.FC<BookmarkCardProps> = ({
  bookmark,
  collections,
  onOpen,
  onToggleFavorite,
  onDelete,
  onEdit,
  onSelectTag,
}) => {
  const [copied, setCopied] = useState(false);
  const [imgError, setImgError] = useState(false);

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
      className="glass-card rounded-2xl overflow-hidden flex flex-col group cursor-pointer border border-white/5 relative"
    >
      {/* Top Banner / OG Preview */}
      <div className="h-36 w-full bg-surface-200/50 relative overflow-hidden flex items-center justify-center">
        {bookmark.image_url && !imgError ? (
          <img
            src={bookmark.image_url}
            alt={bookmark.title}
            onError={() => setImgError(true)}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-surface-100 to-surface-200 flex flex-col items-center justify-center text-slate-400 p-4">
            <Globe className="w-8 h-8 opacity-40 mb-1" />
            <span className="text-xs font-mono opacity-60 truncate max-w-[80%]">
              {bookmark.domain}
            </span>
          </div>
        )}

        {/* Floating Domain & Favicon */}
        <div className="absolute top-2.5 left-2.5 flex items-center space-x-1.5 px-2 py-1 rounded-lg bg-surface-50/85 backdrop-blur-md border border-white/10 text-[11px] text-slate-200 font-medium">
          {bookmark.favicon_url ? (
            <img
              src={bookmark.favicon_url}
              alt=""
              className="w-3.5 h-3.5 rounded-sm shrink-0"
              onError={(e) => {
                (e.target as HTMLElement).style.display = "none";
              }}
            />
          ) : (
            <Globe className="w-3.5 h-3.5 text-slate-400" />
          )}
          <span className="truncate max-w-[120px]">{bookmark.domain}</span>
        </div>

        {/* Favorite Button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite(bookmark.id, bookmark.is_favorite);
          }}
          className={`absolute top-2.5 right-2.5 p-1.5 rounded-lg backdrop-blur-md transition-all ${
            bookmark.is_favorite
              ? "bg-amber-500/20 text-amber-400 border border-amber-500/40"
              : "bg-surface-50/70 text-slate-400 hover:text-white border border-white/10 opacity-0 group-hover:opacity-100"
          }`}
          title={bookmark.is_favorite ? "Убрать из избранного" : "В избранное"}
        >
          <Star
            className={`w-3.5 h-3.5 ${
              bookmark.is_favorite ? "fill-amber-400 text-amber-400" : ""
            }`}
          />
        </button>

        {/* Collection Badge */}
        {collection && (
          <div
            className="absolute bottom-2.5 left-2.5 px-2 py-0.5 rounded-md text-[10px] font-medium backdrop-blur-md border border-white/10 flex items-center space-x-1"
            style={{
              backgroundColor: `${collection.color || "#6366f1"}25`,
              color: collection.color || "#6366f1",
            }}
          >
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ backgroundColor: collection.color || "#6366f1" }}
            />
            <span>{collection.name}</span>
          </div>
        )}
      </div>

      {/* Card Body */}
      <div className="p-4 flex-1 flex flex-col justify-between space-y-3">
        <div className="space-y-1.5">
          <h3
            className="text-sm font-semibold text-slate-100 group-hover:text-brand-400 transition-colors line-clamp-2 leading-snug"
            title={bookmark.title}
          >
            {bookmark.title || bookmark.url}
          </h3>

          {bookmark.description && (
            <p className="text-xs text-slate-400 line-clamp-2 leading-relaxed">
              {bookmark.description}
            </p>
          )}
        </div>

        {/* Tags */}
        {bookmark.tags && bookmark.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-1">
            {bookmark.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectTag?.(tag);
                }}
                className="text-[10px] px-1.5 py-0.5 rounded-md bg-surface-200/80 text-slate-300 hover:bg-brand-600/30 hover:text-brand-300 transition-colors"
              >
                #{tag}
              </span>
            ))}
            {bookmark.tags.length > 3 && (
              <span className="text-[10px] text-slate-400 px-1 py-0.5">
                +{bookmark.tags.length - 3}
              </span>
            )}
          </div>
        )}

        {/* Card Footer */}
        <div className="pt-2 border-t border-white/5 flex items-center justify-between text-slate-400 text-[11px]">
          <span className="flex items-center space-x-1 text-slate-400">
            <Clock className="w-3 h-3" />
            <span>{formattedDate}</span>
          </span>

          <div className="flex items-center space-x-1 opacity-80 group-hover:opacity-100 transition-opacity">
            <button
              onClick={handleCopy}
              className="p-1 rounded-md hover:bg-surface-200 text-slate-400 hover:text-slate-200 transition-colors"
              title="Скопировать ссылку"
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
              className="p-1 rounded-md hover:bg-surface-200 text-slate-400 hover:text-slate-200 transition-colors"
              title="Редактировать"
            >
              <Edit2 className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (confirm("Удалить эту закладку?")) {
                  onDelete(bookmark.id);
                }
              }}
              className="p-1 rounded-md hover:bg-surface-200 text-slate-400 hover:text-rose-400 transition-colors"
              title="Удалить"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onOpen(bookmark.url);
              }}
              className="p-1 rounded-md hover:bg-surface-200 text-slate-400 hover:text-white transition-colors"
              title="Открыть в браузере"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
