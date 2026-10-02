import React, { useState } from "react";
import { X, Bookmark, Copy, Check, MousePointer, Sparkles } from "lucide-react";

interface BookmarkletModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const BookmarkletModal: React.FC<BookmarkletModalProps> = ({ isOpen, onClose }) => {
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const bookmarkletCode = `javascript:(function(){const u=encodeURIComponent(window.location.href),t=encodeURIComponent(document.title);fetch(\`http://127.0.0.1:28765/api/add?url=\${u}&title=\${t}\`,{mode:'no-cors'}).then(()=>{const n=document.createElement('div');n.innerText='✓ OddClicks: Закладка сохранена!';n.style='position:fixed;top:20px;right:20px;z-index:999999;background:#10b981;color:#fff;padding:12px 20px;border-radius:12px;font-family:sans-serif;font-size:14px;font-weight:600;box-shadow:0 10px 25px rgba(0,0,0,0.3);pointer-events:none;transition:all 0.3s ease;';document.body.appendChild(n);setTimeout(()=>n.remove(),2500);}).catch(()=>alert('Запустите приложение OddClicks на вашем компьютере!'));})();`;

  const handleCopyCode = () => {
    navigator.clipboard.writeText(bookmarkletCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        className="w-full max-w-xl bg-surface-100 rounded-2xl border border-white/10 shadow-2xl p-6 relative space-y-6"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/20 text-indigo-400 flex items-center justify-center">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">1-Click Букмарклет</h2>
              <p className="text-xs text-slate-400">Сохраняйте ссылки из любого браузера в один клик</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-surface-200 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Drag Me Box */}
        <div className="p-6 rounded-2xl bg-gradient-to-br from-surface-200/90 to-surface-100 border border-brand-500/30 flex flex-col items-center justify-center text-center space-y-4">
          <p className="text-xs text-slate-300">
            Перетащите эту кнопку на панель закладок вашего браузера (<strong>Ctrl + Shift + B</strong> чтобы показать панель):
          </p>

          <a
            href={bookmarkletCode}
            onClick={(e) => e.preventDefault()}
            className="px-5 py-3 rounded-xl bg-gradient-to-r from-brand-600 via-indigo-600 to-accent-violet text-white text-sm font-bold shadow-lg hover:shadow-indigo-500/30 flex items-center space-x-2.5 cursor-grab active:cursor-grabbing border border-white/20 select-none group"
            title="Перетащите меня на панель закладок!"
          >
            <Bookmark className="w-4 h-4 fill-white text-white group-hover:scale-110 transition-transform" />
            <span>📌 Сохранить в OddClicks</span>
            <MousePointer className="w-4 h-4 opacity-70 group-hover:translate-x-1 group-hover:-translate-y-1 transition-transform" />
          </a>

          <p className="text-[11px] text-slate-400 flex items-center space-x-1">
            <span>💡 Поддерживает Chrome, Microsoft Edge, Firefox, Brave, Arc, Opera</span>
          </p>
        </div>

        {/* Step by step manual guide */}
        <div className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Или создайте закладку вручную:
          </h4>
          <ol className="text-xs text-slate-300 space-y-2 list-decimal list-inside bg-surface-200/50 p-3.5 rounded-xl border border-white/5">
            <li>Создайте любую новую закладку в браузере (нажав <strong>Ctrl + D</strong>).</li>
            <li>Назовите её <strong>«OddClicks»</strong>.</li>
            <li>В поле <strong>URL</strong> вставьте скопированный JS-код ниже:</li>
          </ol>

          <div className="flex items-center space-x-2">
            <input
              type="text"
              readOnly
              value={bookmarkletCode}
              className="flex-1 h-9 px-3 bg-surface-200 border border-white/10 rounded-xl text-[11px] font-mono text-slate-400 select-all focus:outline-none"
            />
            <button
              onClick={handleCopyCode}
              className="h-9 px-3.5 bg-brand-600 hover:bg-brand-500 text-white rounded-xl text-xs font-semibold flex items-center space-x-1.5 transition-colors shrink-0"
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? "Скопировано!" : "Копировать код"}</span>
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="pt-2 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-medium bg-surface-200 hover:bg-surface-300 text-slate-200 transition-colors"
          >
            Понятно, закрыть
          </button>
        </div>
      </div>
    </div>
  );
};
