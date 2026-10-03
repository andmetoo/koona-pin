import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import { isTauri } from "../../services/api";
import { Icon } from "../icons";

/**
 * The window has no system frame: this strip drags it and holds the window
 * buttons. The frames in Lunacy do not draw window controls.
 */
export function WindowBar() {
  const { t } = useTranslation();
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
  const button =
    "flex h-8 w-11 items-center justify-center text-icon transition-colors duration-150 hover:bg-hover hover:text-ink";
  return (
    <header className="flex h-8 shrink-0 items-center justify-end" data-tauri-drag-region>
      {!isTauri() && (
        <span className="mr-auto pl-8 text-2xs text-subtle" data-tauri-drag-region>
          {t("window.demo")}
        </span>
      )}
      <button
        className={button}
        aria-label={t("window.minimize")}
        onClick={() => {
          if (isTauri()) void getCurrentWindow().minimize();
        }}
      >
        <Icon icon={Minus} size={14} />
      </button>
      <button
        className={button}
        aria-label={maximized ? t("window.restore") : t("window.maximize")}
        onClick={() => {
          if (isTauri()) void getCurrentWindow().toggleMaximize();
        }}
      >
        <Icon icon={maximized ? Copy : Square} size={12} />
      </button>
      <button
        className={`${button} hover:!bg-[#c42b1c] hover:!text-white`}
        aria-label={t("window.close")}
        onClick={() => {
          if (isTauri()) void getCurrentWindow().close();
        }}
      >
        <Icon icon={X} size={14} />
      </button>
    </header>
  );
}
