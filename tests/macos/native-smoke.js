// Runs in the actual bundled WKWebView, before React; there is no demo adapter or IPC mock.
(() => {
  const config = window.__MACOS_SMOKE_CONFIG__;
  for (const [key, value] of Object.entries({
    language: config.lang, theme: config.theme, view: config.view, importBanner: "done",
  })) localStorage.setItem(`koonapin.${key}`, value);
  const errors = [];
  window.addEventListener("error", (e) => errors.push(e.message));
  window.addEventListener("unhandledrejection", (e) => errors.push(String(e.reason)));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const waitFor = async (read, what) => {
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      try { const value = await read(); if (value) return value; } catch { /* Library opening. */ }
      await sleep(100);
    }
    throw new Error(`Timed out: ${what}`);
  };
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
  const query = (search, extra = {}) => invoke("get_bookmarks", { query: { search, ...extra } });
  async function run() {
    const checks = [];
    try {
      await waitFor(() => window.__TAURI_INTERNALS__ && document.querySelector("aside"), "React and Tauri");
      await waitFor(() => invoke("get_counts"), "SQLite library");
      if (config.verify) {
        const added = await invoke("add_bookmark", {
          url: "https://macos-smoke.invalid/", title: "Mac smoke Кириллица", collectionId: null, tags: ["macos"],
        });
        const id = added.bookmark.id;
        assert(!added.existing && !added.restored, "New bookmark was not added");
        checks.push("add through real IPC");
        const duplicate = await invoke("add_bookmark", {
          url: added.bookmark.url, title: "Duplicate", collectionId: null, tags: [],
        });
        assert(duplicate.existing && duplicate.bookmark.id === id, "Duplicate was not recognized");
        checks.push("duplicate keeps original");
        assert((await query("кириллица")).items.some((b) => b.id === id), "Cyrillic search failed");
        checks.push("SQLite FTS Cyrillic search");
        await invoke("trash_bookmark", { id });
        assert(!(await query("Mac smoke")).items.some((b) => b.id === id), "Trashed link still in library");
        assert((await query("Mac smoke", { only_trash: true })).items.some((b) => b.id === id), "Trash missing link");
        checks.push("trash hides link from library");
        const restored = await invoke("restore_bookmark", { id });
        assert((await query("Mac smoke")).items.some((b) => b.id === id), "Restore failed");
        const undone = await invoke("undo", { command: restored.command });
        assert(undone.outcome === "undone", "Undo failed");
        assert((await query("Mac smoke", { only_trash: true })).items.some((b) => b.id === id), "Undo did not restore trash state");
        checks.push("restore and undo");
      }
      assert(location.protocol === "tauri:", "App is not using the bundled custom protocol");
      if (!config.persistOnly) {
        const restored = await invoke("restore_library", { content: JSON.stringify(config.library), mode: "replace" });
        assert(restored.outcome === "restored", `JSON restore failed: ${JSON.stringify(restored)}`);
      }
      const counts = await invoke("get_counts");
      assert(counts.total === config.library.bookmarks.length && counts.trash === 0, "Restored fixture counts differ");
      checks.push(config.persistOnly ? "SQLite persists across app restart" : "JSON restore into real SQLite");
      // Let the fixture update reach React's virtualized grid/list.
      await waitFor(() => document.querySelector(`[data-view='${config.view}'] [data-bookmark-id]`), "Rendered library");
      await document.fonts.ready;
      assert(document.documentElement.dataset.theme === config.theme, "Wrong theme");
      assert(document.documentElement.lang.startsWith(config.lang), "Wrong language");
      checks.push("WKWebView renders selected theme, language and view");
      await sleep(700);
      assert(errors.length === 0, `JavaScript errors: ${errors.join("; ")}`);
      const capture = await invoke("get_capture_status");
      await invoke("macos_smoke_report", {
        result: { ok: true, checks, errors, capture, counts, lang: config.lang, theme: config.theme,
          view: config.view, userAgent: navigator.userAgent, embedded: location.protocol === "tauri:" },
      });
    } catch (error) {
      await invoke("macos_smoke_report", { result: { ok: false, checks, errors, error: String(error) } });
    }
  }
  // The Tauri bridge is initialized after this plugin's initialization script.
  setTimeout(run, 0);
})();
