// The quick search popup's rules without the page (NP-082, sheet 37): colours,
// dates, what an answer of the app means, and the shortcut from a key press.
import { appIsOlder } from "./native.js";

/** Collection colours of the app (src/services/collections.ts): by id, light and dark. */
const COLLECTIONS = [
  ["#c9785a", "#d99272"],
  ["#5b8a72", "#7db096"],
  ["#5c77a8", "#8aa3d0"],
  ["#b59a45", "#d4b862"],
  ["#8a6ba8", "#b096cc"],
];
export const collectionColor = (id, dark = false) =>
  COLLECTIONS[(Math.abs(id) - 1 + COLLECTIONS.length) % COLLECTIONS.length][dark ? 1 : 0];

/**
 * A site's tile: its first letter on a colour of its own. The popup makes no
 * network requests (Р-40), so it draws no favicons.
 */
const TILES = ["#c9785a", "#5b8a72", "#5c77a8", "#b59a45", "#8a6ba8", "#2f6b4f", "#af3838", "#4a4b44"];
export function siteTile(domain) {
  const name = String(domain || "").replace(/^www\./, "");
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  const letter = (name.match(/[\p{L}\p{N}]/u)?.[0] ?? "•").toUpperCase();
  return { letter, color: TILES[hash % TILES.length] };
}

/** «Today», then «Oct 2», then «Oct 2, 2025» for another year. */
export function shortDate(iso, { now = new Date(), language = "en", today = "Today" } = {}) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  if (date.toDateString() === now.toDateString()) return today;
  const options = { day: "numeric", month: "short" };
  if (date.getFullYear() !== now.getFullYear()) options.year = "numeric";
  return date.toLocaleDateString(language, options);
}

/**
 * What the popup shows for an answer: results, or why there are none.
 * An app before NP-082 does not know the message: it should be updated, and
 * saving keeps working.
 */
export function answerState(reply) {
  if (reply?.ok) return "results";
  switch (reply?.code) {
    case "host_missing":
      return "missing";
    case "host_forbidden":
      return "forbidden";
    case "invalid_request":
      return "update-app";
    case "incompatible_protocol":
      return appIsOlder(reply) ? "update-app" : "update-extension";
    case "database_error":
      return "library";
    default:
      return "unavailable";
  }
}

const KEYS = /^(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|Comma|Period|Home|End|PageUp|PageDown|Space|Insert|Delete|Up|Down|Left|Right)$/;
/**
 * A shortcut for `commands.update` from a key press, or null while only
 * modifiers are held or the combination is one browsers refuse: Ctrl or Alt
 * is required, Ctrl+Alt is not allowed.
 */
export function shortcutFrom(event) {
  const named = { " ": "Space", ",": "Comma", ".": "Period", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right" };
  const code = /^Key([A-Z])$/.exec(event.code)?.[1] ?? /^Digit(\d)$/.exec(event.code)?.[1];
  const key = code ?? named[event.key] ?? (event.key.length === 1 ? event.key.toUpperCase() : event.key);
  if (!KEYS.test(key)) return null;
  if (!event.ctrlKey && !event.altKey) return null;
  if (event.ctrlKey && event.altKey) return null;
  return [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", key].filter(Boolean).join("+");
}
