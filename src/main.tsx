import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/app.css";
import { onTrayLabels } from "./i18n";
import { App } from "./App";
import { LibraryGate } from "./components/LibraryGate";
import { api } from "./services/api";
import { blockBrowserChrome } from "./services/browserChrome";
import { trackInputMode } from "./services/inputMode";
import { applyTheme, isDark, storedTheme } from "./services/preferences";
import { applySeason } from "./services/season";
// Supporter's reading themes and fonts (commercial, NP-124): the only import of them. Without this
// line the community build shows them locked in the Aa panel (readerLook.ts).
import "./components/commercial/readerThemes";

// Before the first paint, so a dark theme does not flash light.
applyTheme(isDark(storedTheme(), matchMedia("(prefers-color-scheme: dark)").matches));
// The Supporter heart takes the colour of the season (NP-066).
applySeason();
// Linux, before the first paint (2.1.1): WebKitGTK rendering in software at times leaves the whole
// window blank under a backdrop blur or a mask, so the glass and fades stay off there (app.css).
if (/\b(Linux|X11)\b/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent)) document.documentElement.dataset.linux = "";
blockBrowserChrome(window);
// A card's ring of keyboard focus only after a key that moves focus, not after a click and Esc.
trackInputMode(window, document.documentElement);
// The tray speaks the interface's language, after a start in the tray too: the hidden window loads.
onTrayLabels((labels) => void api.setTrayLabels(labels).catch(console.error));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <LibraryGate>
      <App />
    </LibraryGate>
  </React.StrictMode>,
);
