import React, { useState, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, Copy, X, BookmarkCheck } from "lucide-react";
import { isTauri } from "../services/api";

export const TitleBar: React.FC = () => {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    const appWindow = getCurrentWindow();
    const updateMaximized = async () => {
      setIsMaximized(await appWindow.isMaximized());
    };
    updateMaximized();
    const unlistenPromise = appWindow.onResized(updateMaximized);
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const handleMinimize = async () => {
    if (!isTauri()) return;
    await getCurrentWindow().minimize();
  };

  const handleToggleMaximize = async () => {
    if (!isTauri()) return;
    await getCurrentWindow().toggleMaximize();
  };

  const handleClose = async () => {
    if (!isTauri()) return;
    await getCurrentWindow().close();
  };

  return (
    <header
      data-tauri-drag-region
      className="h-10 w-full flex items-center justify-between px-3 bg-surface-100/90 border-b border-white/5 select-none z-50 shrink-0 text-slate-300"
    >
      <div className="flex items-center space-x-2.5 pointer-events-none">
        <div className="w-5 h-5 rounded-md bg-gradient-to-tr from-brand-600 to-accent-violet flex items-center justify-center shadow-sm">
          <BookmarkCheck className="w-3.5 h-3.5 text-white" />
        </div>
        <span className="text-xs font-semibold tracking-wide text-slate-200">
          OddClicks
        </span>
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/5 text-slate-400 font-mono">
          v0.1.0
        </span>
      </div>

      <div className="flex items-center space-x-1 h-full -mr-3">
        <button
          onClick={handleMinimize}
          className="h-10 w-11 flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
          title="Свернуть"
        >
          <Minus className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={handleToggleMaximize}
          className="h-10 w-11 flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
          title={isMaximized ? "Восстановить" : "Развернуть"}
        >
          {isMaximized ? (
            <Copy className="w-3.5 h-3.5 rotate-180" />
          ) : (
            <Square className="w-3.5 h-3.5" />
          )}
        </button>
        <button
          onClick={handleClose}
          className="h-10 w-11 flex items-center justify-center text-slate-400 hover:text-white hover:bg-rose-600 transition-colors"
          title="Закрыть"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};
