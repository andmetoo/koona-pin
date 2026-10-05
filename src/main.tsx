import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/app.css";
import { onTrayLabels } from "./i18n";
import { App } from "./App";
import { LibraryGate } from "./components/LibraryGate";
import { api } from "./services/api";
import { applyTheme, isDark, storedTheme } from "./services/preferences";

// Before the first paint, so a dark theme does not flash light.
applyTheme(isDark(storedTheme(), matchMedia("(prefers-color-scheme: dark)").matches));
// The tray speaks the interface's language, after a start in the tray too: the hidden window loads.
onTrayLabels((labels) => void api.setTrayLabels(labels).catch(console.error));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <LibraryGate>
      <App />
    </LibraryGate>
  </React.StrictMode>,
);
