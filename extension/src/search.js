import { ext, t, textLanguage } from "./ext.js";
import { talk } from "./native.js";
import { answerState, collectionColor, shortDate, siteTile } from "./search-model.js";

// The button was given this popup only to open it once (Р-40): a click on it
// saves the page again.
void ext.action?.setPopup?.({ popup: "" })?.catch?.(() => {});

// The site in the browser's language (NP-107).
const DOWNLOAD = t("siteUrl");
const get = (id) => document.getElementById(id);
const query = get("query");
const content = get("content");
const filters = get("filters");
const dark = matchMedia("(prefers-color-scheme: dark)");
const state = { filter: { kind: "all" }, items: [], selected: 0, counts: null, more: false, turn: 0, copied: false };

function translate() {
  // The language of the catalog the text comes from: a zh-TW browser reads English (NP-090).
  document.documentElement.lang = textLanguage();
  for (const node of document.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll("[data-i18n-placeholder]")) node.placeholder = t(node.dataset.i18nPlaceholder);
  for (const node of document.querySelectorAll("[data-i18n-label]")) node.setAttribute("aria-label", t(node.dataset.i18nLabel));
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function dot(color) {
  const node = element("span", "dot");
  node.style.background = color;
  return node;
}
const sameFilter = (a, b) => a.kind === b.kind && a.id === b.id;
const collectionName = (id) => state.counts?.collections.find((c) => c.id === id)?.name ?? "";

/** One answer per typed query; an older answer never replaces a newer one. */
async function search() {
  const turn = ++state.turn;
  // The app may be starting in the tray (Р-40): say so if the first answer is slow.
  const slow = setTimeout(() => turn === state.turn && !state.counts && starting(), 300);
  const reply = await talk({ type: "search", query: query.value, filter: state.filter });
  clearTimeout(slow);
  if (turn !== state.turn) return;
  const kind = answerState(reply);
  if (kind !== "results") return problem(kind);
  Object.assign(state, { items: reply.items, counts: reply.counts, more: reply.more, selected: 0 });
  render();
}
let typing = 0;
// An IME (Chinese, Japanese, Korean) builds a character over several keys:
// the list waits for the finished one (NP-090).
const later = () => {
  clearTimeout(typing);
  typing = setTimeout(() => {
    typing = 0;
    void search();
  }, 120);
};
/** The answer for what is typed now: Enter right after a character must not open the previous list. */
async function current() {
  if (!typing) return;
  clearTimeout(typing);
  typing = 0;
  await search();
}
query.addEventListener("input", (event) => {
  if (!event.isComposing) later();
});
query.addEventListener("compositionend", later);

function renderFilters() {
  filters.replaceChildren();
  const counts = state.counts;
  if (!counts) return;
  const chips = [
    [{ kind: "all" }, t("searchAll"), counts.all],
    [{ kind: "inbox" }, t("searchInbox"), counts.inbox],
    [{ kind: "favorites" }, t("searchFavorites"), counts.favorites],
    ...counts.collections.map((c) => [{ kind: "collection", id: c.id }, c.name, c.count]),
  ];
  for (const [filter, label, count] of chips) {
    const chip = element("button", "chip");
    chip.type = "button";
    chip.setAttribute("aria-pressed", String(sameFilter(filter, state.filter)));
    if (filter.kind === "collection") chip.append(dot(collectionColor(filter.id, dark.matches)));
    chip.append(`${label} ${count}`);
    chip.addEventListener("click", () => {
      state.filter = filter;
      query.focus();
      void search();
    });
    filters.append(chip);
  }
  filters.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function row(item, index) {
  const node = element("li");
  node.id = `item-${index}`;
  node.setAttribute("role", "option");
  node.setAttribute("aria-selected", String(index === state.selected));
  const site = siteTile(item.domain);
  const tile = element("span", "tile", site.letter);
  tile.style.background = site.color;
  tile.setAttribute("aria-hidden", "true");
  const text = element("div", "text");
  const meta = element("div", "meta");
  meta.append(element("span", "", item.domain));
  if (item.collection_id) meta.append(dot(collectionColor(item.collection_id, dark.matches)), element("span", "", collectionName(item.collection_id)));
  else if (item.inbox) meta.append(element("span", "", `· ${t("searchInbox")}`));
  text.append(element("div", "title", item.title || item.url), meta);
  const side =
    index === state.selected
      ? element("kbd", "", `↵ ${t("searchOpen")}`)
      : element("span", "date", shortDate(item.created_at, { language: textLanguage(), today: t("searchToday") }));
  node.append(tile, text, side);
  node.addEventListener("mousemove", () => select(index));
  node.addEventListener("click", (event) => open(item, event.shiftKey));
  return node;
}

function render() {
  renderFilters();
  content.replaceChildren();
  query.removeAttribute("aria-activedescendant");
  if (!state.items.length) return nothing();
  if (!query.value.trim()) content.append(element("p", "section", t("searchRecent")));
  const list = element("ul");
  list.id = "results";
  list.setAttribute("role", "listbox");
  state.items.forEach((item, index) => list.append(row(item, index)));
  content.append(list);
  if (state.more) content.append(element("p", "more", t("searchMore", state.items.length)));
  query.setAttribute("aria-activedescendant", `item-${state.selected}`);
}

function nothing() {
  const box = element("div", "empty");
  const words = query.value.trim();
  if (!words && state.filter.kind === "all") {
    box.append(element("p", "title", t("searchEmptyLibrary")), element("p", "text", t("searchEmptyLibraryText")));
  } else {
    const where = { inbox: t("searchInbox"), favorites: t("searchFavorites"), collection: collectionName(state.filter.id) }[state.filter.kind];
    const title = where ? t("searchNothingIn", words, where) : t("searchNothing", words);
    box.append(element("p", "title", words ? title : t("searchNothingHere", where)), element("p", "text", t("searchNothingText")));
    if (state.filter.kind !== "all") {
      const everywhere = element("button", "", t("searchEverywhere"));
      everywhere.type = "button";
      everywhere.addEventListener("click", () => {
        state.filter = { kind: "all" };
        query.focus();
        void search();
      });
      box.append(everywhere);
    }
  }
  content.append(box);
}

function starting() {
  filters.replaceChildren();
  content.replaceChildren();
  const status = element("p", "status");
  status.append(dot("var(--accent)"), t("searchStarting"));
  content.append(status);
  for (const [title, meta] of [[260, 120], [220, 90], [290, 140], [200, 80], [240, 110]]) {
    const line = element("div", "skeleton");
    const bars = element("div", "text");
    const a = element("i");
    a.style.cssText = `width:${title}px;height:10px`;
    const b = element("i");
    b.style.cssText = `width:${meta}px;height:8px;margin-top:9px`;
    bars.append(a, b);
    const icon = element("i");
    icon.style.cssText = "width:20px;height:20px;border-radius:5px";
    line.append(icon, bars);
    content.append(line);
  }
}

function button(text, onClick, className = "") {
  const node = element("button", className, text);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}
const download = () => void ext.tabs.create({ url: DOWNLOAD }).then(() => window.close());

/** Why there are no results; saving keeps working in every case. */
function problem(kind) {
  state.counts = null;
  state.items = [];
  filters.replaceChildren();
  content.replaceChildren();
  const [title, text, action, danger] = {
    missing: [t("statusMissing"), t("searchMissingText"), button(t("download"), download), true],
    "update-app": [t("searchUpdateApp"), t("searchUpdateAppText"), button(t("searchUpdateButton"), download, "primary")],
    "update-extension": [t("statusUpdate"), t("searchUpdateExtensionText"), null],
    library: [t("searchLibrary"), t("searchLibraryText"), button(t("searchOpenApp"), showApp)],
    unavailable: [t("searchUnavailable"), t("searchUnavailableText"), button(t("checkAgain"), () => void search())],
  }[kind];
  const notice = element("div", danger ? "notice danger" : "notice");
  notice.setAttribute("role", "alert");
  notice.append(element("p", "title", title), element("p", "text", text));
  if (action) notice.append(action);
  content.append(notice);
}

function select(index) {
  if (index === state.selected || !state.items[index]) return;
  state.selected = index;
  for (const node of content.querySelectorAll("li")) {
    const chosen = node.id === `item-${index}`;
    node.setAttribute("aria-selected", String(chosen));
    const side = node.lastElementChild;
    const item = state.items[Number(node.id.slice(5))];
    const next = chosen
      ? element("kbd", "", `↵ ${t("searchOpen")}`)
      : element("span", "date", shortDate(item.created_at, { language: textLanguage(), today: t("searchToday") }));
    side.replaceWith(next);
    if (chosen) node.scrollIntoView({ block: "nearest" });
  }
  query.setAttribute("aria-activedescendant", `item-${index}`);
}

/** Enter opens in a new tab, Shift Enter in this one; the popup closes. */
async function open(item, here) {
  if (here) await ext.tabs.update({ url: item.url });
  else await ext.tabs.create({ url: item.url });
  window.close();
}
async function showApp() {
  await talk({ type: "show" });
  window.close();
}
get("open").addEventListener("click", () => void showApp());

document.addEventListener("keydown", async (event) => {
  // Enter, Esc and arrows inside an IME pick and confirm characters (NP-090).
  if (event.isComposing || event.keyCode === 229) return;
  const item = state.items[state.selected];
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    select(Math.min(state.items.length - 1, Math.max(0, state.selected + (event.key === "ArrowDown" ? 1 : -1))));
  } else if (event.key === "Enter" && (item || typing) && !event.target.closest?.("button")) {
    event.preventDefault();
    await current();
    const chosen = state.items[state.selected];
    if (chosen) await open(chosen, event.shiftKey);
  } else if (event.key === "Escape") {
    window.close();
  } else if ((event.ctrlKey || event.metaKey) && event.code === "KeyC" && item && query.selectionStart === query.selectionEnd) {
    // Ctrl C copies the chosen link unless text in the field is selected.
    event.preventDefault();
    await navigator.clipboard.writeText(item.url);
    get("keys").textContent = t("searchCopied");
    setTimeout(() => (get("keys").textContent = t("searchKeys")), 1500);
  }
});
dark.addEventListener("change", render);

translate();
query.focus();
void search();
