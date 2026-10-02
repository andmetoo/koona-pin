import React, { useState } from "react";
import { X, Upload, FileText, CheckCircle2, Loader2, AlertCircle } from "lucide-react";

interface ImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImport: (content: string) => Promise<number>;
}

export const ImportModal: React.FC<ImportModalProps> = ({
  isOpen,
  onClose,
  onImport,
}) => {
  const [loading, setLoading] = useState(false);
  const [resultCount, setResultCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setError(null);
    setResultCount(null);

    try {
      const text = await file.text();
      const count = await onImport(text);
      setResultCount(count);
    } catch (err) {
      console.error(err);
      setError("Ошибка импорта: " + err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        className="w-full max-w-md bg-surface-100 rounded-2xl border border-white/10 shadow-2xl p-6 relative space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded-lg bg-accent-cyan/20 text-accent-cyan flex items-center justify-center">
              <Upload className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Импорт закладок</h2>
              <p className="text-xs text-slate-400">Из Chrome, Edge, Firefox или Safari</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-surface-200 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Dropzone / Upload area */}
        <div className="border-2 border-dashed border-white/10 hover:border-brand-500/50 rounded-2xl p-8 text-center bg-surface-200/30 transition-all flex flex-col items-center justify-center space-y-3 relative group">
          <input
            type="file"
            accept=".html,.htm"
            onChange={handleFileChange}
            disabled={loading}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
          />

          <div className="w-12 h-12 rounded-xl bg-surface-200 flex items-center justify-center text-slate-300 group-hover:scale-110 transition-transform">
            {loading ? (
              <Loader2 className="w-6 h-6 animate-spin text-brand-400" />
            ) : (
              <FileText className="w-6 h-6 text-brand-400" />
            )}
          </div>

          <div>
            <p className="text-sm font-medium text-slate-200">
              Нажмите или перетащите HTML-файл закладок
            </p>
            <p className="text-xs text-slate-400 mt-1">
              Экспорт из браузера: Закладки → Диспетчер закладок → Экспорт в HTML
            </p>
          </div>
        </div>

        {/* Success message */}
        {resultCount !== null && (
          <div className="p-3 bg-emerald-500/20 border border-emerald-500/30 rounded-xl flex items-center space-x-2.5 text-emerald-300 text-xs">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>Успешно импортировано закладок: <strong>{resultCount}</strong></span>
          </div>
        )}

        {/* Error message */}
        {error && (
          <div className="p-3 bg-rose-500/20 border border-rose-500/30 rounded-xl flex items-center space-x-2.5 text-rose-300 text-xs">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex justify-end pt-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-medium bg-surface-200 hover:bg-surface-300 text-slate-200 transition-colors"
          >
            {resultCount !== null ? "Готово" : "Отмена"}
          </button>
        </div>
      </div>
    </div>
  );
};
