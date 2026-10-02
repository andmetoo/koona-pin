import { useEffect, useState } from "react";
import { Bookmark, Copy, Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "../../services/api";
export function WindowBar() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    const window = getCurrentWindow();
    const update = () => {
      void window.isMaximized().then(setMaximized);
    };
    update();
    const listening = window.onResized(update);
    return () => {
      void listening.then((off) => off());
    };
  }, []);
  return (
    <header className="study-titlebar" data-tauri-drag-region>
      <span className="study-wordmark" data-tauri-drag-region>
        <Bookmark size={14} />
        OddClicks{!isTauri() && <span className="demo-label">Демо</span>}
      </span>
      <div>
        <button
          aria-label="Свернуть"
          onClick={() => {
            if (isTauri()) void getCurrentWindow().minimize();
          }}
        >
          <Minus size={13} />
        </button>
        <button
          aria-label={maximized ? "Восстановить" : "Развернуть"}
          onClick={() => {
            if (isTauri()) void getCurrentWindow().toggleMaximize();
          }}
        >
          {maximized ? <Copy size={11} /> : <Square size={11} />}
        </button>
        <button
          aria-label="Закрыть окно"
          onClick={() => {
            if (isTauri()) void getCurrentWindow().close();
          }}
        >
          <X size={14} />
        </button>
      </div>
    </header>
  );
}
