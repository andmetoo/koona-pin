import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/app.css";
import "./i18n";
import { App } from "./App";
import { LibraryGate } from "./components/LibraryGate";
import { applyTheme, isDark, storedTheme } from "./services/preferences";

// Before the first paint, so a dark theme does not flash light.
applyTheme(isDark(storedTheme(), matchMedia("(prefers-color-scheme: dark)").matches));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <LibraryGate>
      <App />
    </LibraryGate>
  </React.StrictMode>,
);
