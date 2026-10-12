import { useEffect, useRef, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import { api, isTauri } from "../../services/api";
import { Desktop, WindowButton } from "../../types";
import { Icon } from "../icons";

/**
 * In a frameless window this strip drags it and holds the window
 * buttons. Windows keeps its own three; on Linux the buttons follow the
 * system's layout and are round (sheet 40, NP-053). The library frames in
 * Lunacy do not draw window controls. macOS uses its real system title bar.
 */
export function WindowBar() {
  const { t } = useTranslation();
  const [maximized, setMaximized] = useState(false);
  const [desktop, setDesktop] = useState<Desktop | null>(null);
  const linux = useRef(false);
  useEffect(() => {
    let alive = true;
    const load = () =>
      void api
        .getDesktop()
        .then((next) => {
          linux.current = next.linux;
          if (alive) setDesktop(next);
        })
        .catch(() => {});
    load();
    if (!isTauri()) {
      return () => {
        alive = false;
      };
    }
    const appWindow = getCurrentWindow();
    let reload = 0;
    const update = () => {
      void appWindow.isMaximized().then(setMaximized);
      // Hyprland tiles or floats the window: the buttons follow once the size settles.
      if (linux.current) {
        window.clearTimeout(reload);
        reload = window.setTimeout(load, 300);
      }
    };
    update();
    const listening = appWindow.onResized(update);
    return () => {
      alive = false;
      window.clearTimeout(reload);
      void listening.then((off) => off());
    };
  }, []);
  useEffect(() => {
    if (!desktop?.native_frame || !isTauri()) return;
    const appWindow = getCurrentWindow();
    const syncTheme = () => {
      const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
      void appWindow.setTheme(theme).catch(console.error);
    };
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, [desktop?.native_frame]);
  const act = (button: WindowButton) => {
    if (!isTauri()) return;
    const appWindow = getCurrentWindow();
    if (button === "minimize") void appWindow.minimize();
    else if (button === "maximize") void appWindow.toggleMaximize();
    else void appWindow.close();
  };
  const label = (button: WindowButton) =>
    button === "minimize"
      ? t("window.minimize")
      : button === "close"
        ? t("window.close")
        : maximized
          ? t("window.restore")
          : t("window.maximize");

  if (desktop?.native_frame) return null;
  if (desktop?.linux) {
    const group = (buttons: WindowButton[]) =>
      buttons.map((button) => (
        <LinuxButton key={button} button={button} label={label(button)} maximized={maximized} onClick={() => act(button)} />
      ));
    return (
      <header className="flex h-8 shrink-0 items-center px-1" data-tauri-drag-region data-buttons="linux" data-window-controls>
        {group(desktop.left)}
        <span className="flex-1 self-stretch" data-tauri-drag-region />
        {group(desktop.right)}
      </header>
    );
  }

  const button =
    "flex h-8 w-11 items-center justify-center text-icon transition-colors duration-150 hover:bg-hover hover:text-ink";
  return (
    <header className="flex h-8 shrink-0 items-center justify-end" data-tauri-drag-region data-window-controls>
      {!isTauri() && (
        <span className="mr-auto pl-8 text-2xs text-subtle" data-tauri-drag-region>
          {t("window.demo")}
        </span>
      )}
      <button className={button} aria-label={label("minimize")} onClick={() => act("minimize")}>
        <Icon icon={Minus} size={14} />
      </button>
      <button className={button} aria-label={label("maximize")} onClick={() => act("maximize")}>
        <Icon icon={maximized ? Copy : Square} size={12} />
      </button>
      <button
        className={`${button} hover:!bg-[#c42b1c] hover:!text-white`}
        aria-label={label("close")}
        onClick={() => act("close")}
      >
        <Icon icon={X} size={14} />
      </button>
    </header>
  );
}

/**
 * A Linux window button: a 32×32 target around a 24 px circle in the text
 * colour at 7 % (12 on hover, 18 pressed; 8 / 14 / 22 in the dark theme), the
 * glyph 8 px wide. «×» is not red.
 */
function LinuxButton({
  button,
  label,
  maximized,
  onClick,
}: {
  button: WindowButton;
  label: string;
  maximized: boolean;
  onClick: () => void;
}) {
  const glyph =
    button === "minimize" ? (
      <Icon icon={Minus} size={14} />
    ) : button === "close" ? (
      <Icon icon={X} size={16} />
    ) : (
      <Icon icon={maximized ? Copy : Square} size={11} />
    );
  return (
    <button
      className="group flex size-8 items-center justify-center rounded-full focus-visible:outline-offset-[-2px]"
      aria-label={label}
      data-window-button={button}
      onClick={onClick}
    >
      <span className="flex size-6 items-center justify-center rounded-full bg-ink/[7%] text-icon transition-colors duration-150 group-hover:bg-ink/[12%] group-hover:text-ink group-active:bg-ink/[18%] dark:bg-ink/[8%] dark:group-hover:bg-ink/[14%] dark:group-active:bg-ink/[22%]">
        {glyph}
      </span>
    </button>
  );
}
