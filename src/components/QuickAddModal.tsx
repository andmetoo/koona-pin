import React, { useState, useEffect } from "react";
import { X, Link as LinkIcon, Hash, Loader2 } from "lucide-react";
import { Collection } from "../types";

interface QuickAddModalProps {
  isOpen: boolean;
  onClose: () => void;
  collections: Collection[];
  onAddBookmark: (data: {
    url: string;
    title?: string;
    collectionId?: number | null;
    tags?: string[];
  }) => Promise<void>;
}

export const QuickAddModal: React.FC<QuickAddModalProps> = ({
  isOpen,
  onClose,
  collections,
  onAddBookmark,
}) => {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [collectionId, setCollectionId] = useState<number | null>(null);
  const [tagInput, setTagInput] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      // Auto-detect clipboard URL if valid
      navigator.clipboard
        ?.readText()
        .then((text) => {
          if (text && (text.startsWith("http://") || text.startsWith("https://"))) {
            setUrl(text);
          }
        })
        .catch(() => {});
    } else {
      setUrl("");
      setTitle("");
      setCollectionId(null);
      setTags([]);
      setTagInput("");
      setLoading(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

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
    if (!url.trim()) return;

    let finalUrl = url.trim();
    if (!finalUrl.startsWith("http://") && !finalUrl.startsWith("https://")) {
      finalUrl = `https://${finalUrl}`;
    }

    setLoading(true);
    try {
      await onAddBookmark({
        url: finalUrl,
        title: title.trim() || undefined,
        collectionId: collectionId,
        tags: tags,
      });
      onClose();
    } catch (err) {
      console.error(err);
      alert("Не удалось добавить закладку: " + err);
    } finally {
      setLoading(false);
    }
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
              <LinkIcon className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Добавить закладку</h2>
              <p className="text-xs text-slate-400">Превью и метаданные подгрузятся автоматически</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-surface-200 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              URL-адрес <span className="text-rose-400">*</span>
            </label>
            <input
              type="text"
              autoFocus
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/article"
              className="w-full h-10 px-3.5 bg-surface-200/70 border border-white/10 rounded-xl text-sm text-white placeholder-slate-400 focus:outline-none focus:border-brand-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Заголовок (необязательно)
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Оставьте пустым для автоопределения"
              className="w-full h-10 px-3.5 bg-surface-200/70 border border-white/10 rounded-xl text-sm text-white placeholder-slate-400 focus:outline-none focus:border-brand-500"
            />
          </div>

          {/* Collection Selector */}
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
                  placeholder="Добавить тег (нажмите Enter)"
                  className="w-full h-9 pl-9 pr-3 bg-surface-200/70 border border-white/10 rounded-xl text-xs text-white placeholder-slate-400 focus:outline-none focus:border-brand-500"
                />
              </div>
              <button
                type="button"
                onClick={handleAddTag}
                className="px-3 h-9 bg-surface-200 hover:bg-surface-300 text-slate-200 rounded-xl text-xs font-medium transition-colors"
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

          {/* Actions */}
          <div className="pt-3 flex items-center justify-end space-x-2.5">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs font-medium text-slate-400 hover:text-white hover:bg-surface-200 transition-colors"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={loading || !url.trim()}
              className="px-5 py-2 rounded-xl bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center space-x-2 transition-all shadow-glow"
            >
              {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              <span>Сохранить закладку</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
