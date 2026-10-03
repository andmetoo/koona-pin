import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { LibraryGate } from "./components/LibraryGate";
import "./concepts/concepts.css";
import "./production.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <LibraryGate>
      <App />
    </LibraryGate>
  </React.StrictMode>,
);
