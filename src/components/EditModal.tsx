import React, { useState, useEffect } from "react";
import { X, Edit3, Hash, Star, Trash2 } from "lucide-react";
import { Bookmark, Collection } from "../types";

interface EditModalProps {
  bookmark: Bookmark | null;
  collections: Collection[];
  isOpen: boolean;
  onClose: () => void;
  onSave: (
    id: number,
    data: {
      title?: string;
      notes?: string;
      is_favorite?: boolean;
      collection_id?: number | null;
      tags?: string[];
    }
  ) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}

export const EditModal: React.FC<EditModalProps> = ({
  bookmark,
  collections,
  isOpen,
  onClose,
  onSave,
  onDelete,
}) => {
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [collectionId, setCollectionId] = useState<number | null>(null);
  const [isFavorite, setIsFavorite] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");

  useEffect(() => {
    if (bookmark && isOpen) {
      setTitle(bookmark.title || "");
      setNotes(bookmark.notes || "");
      setCollectionId(bookmark.collection_id ?? null);
      setIsFavorite(bookmark.is_favorite);
      setTags(bookmark.tags || []);
    }
  }, [bookmark, isOpen]);

  if (!isOpen || !bookmark) return null;

  const handleAddTag = () => {
    const cleanTag = tagInput.trim().toLowerCase().replace(/^[#\s]+/, "");
    if (cleanTag && !tags.includes(cleanTag)) {
      setTags([...tags, cleanTag]);
      setTagInput("");
    }
  };

  const handleRemoveTag = (tagToRemove: string) => {
    setTags(tags.filter((t) => t !== tagToRemove));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSave(bookmark.id, {
      title,
      notes,
      is_favorite: isFavorite,
      collection_id: collectionId,
      tags,
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        className="w-full max-w-lg bg-surface-100 rounded-2xl border border-white/10 shadow-2xl p-6 relative space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded-lg bg-brand-600/20 text-brand-400 flex items-center justify-center">
              <Edit3 className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Редактировать закладку</h2>
              <p className="text-xs text-slate-400 font-mono truncate max-w-sm">{bookmark.url}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-surface-200 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Название
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full h-10 px-3.5 bg-surface-200/70 border border-white/10 rounded-xl text-sm text-white focus:outline-none focus:border-brand-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Коллекция
            </label>
            <select
              value={collectionId || ""}
              onChange={(e) => setCollectionId(e.target.value ? Number(e.target.value) : null)}
              className="w-full h-10 px-3 bg-surface-200/70 border border-white/10 rounded-xl text-sm text-white focus:outline-none focus:border-brand-500"
            >
              <option value="">Без коллекции</option>
              {collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Заметки
            </label>
            <textarea
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Добавьте свои комментарии к ссылке..."
              className="w-full p-3 bg-surface-200/70 border border-white/10 rounded-xl text-xs text-white placeholder-slate-400 focus:outline-none focus:border-brand-500 resize-none"
            />
          </div>

          {/* Tags */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Теги
            </label>
            <div className="flex space-x-2">
              <div className="relative flex-1">
                <Hash className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddTag();
                    }
                  }}
                  placeholder="Добавить тег"
                  className="w-full h-9 pl-9 pr-3 bg-surface-200/70 border border-white/10 rounded-xl text-xs text-white placeholder-slate-400 focus:outline-none focus:border-brand-500"
                />
              </div>
              <button
                type="button"
                onClick={handleAddTag}
                className="px-3 h-9 bg-surface-200 hover:bg-surface-300 text-slate-200 rounded-xl text-xs font-medium"
              >
                + Тег
              </button>
            </div>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {tags.map((t) => (
                  <span
                    key={t}
                    className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-md bg-brand-600/20 text-brand-300 text-xs border border-brand-500/20"
                  >
                    <span>#{t}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveTag(t)}
                      className="text-brand-300 hover:text-white"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center space-x-2 pt-1">
            <input
              type="checkbox"
              id="favoriteCheck"
              checked={isFavorite}
              onChange={(e) => setIsFavorite(e.target.checked)}
              className="rounded bg-surface-200 border-white/10 text-brand-600 focus:ring-0"
            />
            <label htmlFor="favoriteCheck" className="text-xs text-slate-200 flex items-center space-x-1 cursor-pointer">
              <Star className={`w-3.5 h-3.5 ${isFavorite ? "fill-amber-400 text-amber-400" : "text-slate-400"}`} />
              <span>Добавить в Избранное</span>
            </label>
          </div>

          {/* Footer */}
          <div className="pt-4 flex items-center justify-between border-t border-white/5">
            <button
              type="button"
              onClick={async () => {
                if (confirm("Удалить закладку?")) {
                  await onDelete(bookmark.id);
                  onClose();
                }
              }}
              className="px-3 py-2 rounded-xl text-xs font-medium text-rose-400 hover:bg-rose-500/10 flex items-center space-x-1.5 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Удалить</span>
            </button>
            <div className="flex space-x-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-xl text-xs font-medium text-slate-400 hover:text-white hover:bg-surface-200 transition-colors"
              >
                Отмена
              </button>
              <button
                type="submit"
                className="px-5 py-2 rounded-xl bg-brand-600 hover:bg-brand-500 text-white text-xs font-semibold shadow-glow"
              >
                Сохранить
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
