import { ext, t } from "./ext.js";
import { appIsOlder, browserName } from "./native.js";
import { shortcutFrom } from "./search-model.js";
import { VERSION } from "./version.js";
const get = (id) => document.getElementById(id);
// The site in the browser's language (NP-107).
const DOWNLOAD = t("siteUrl");
function translate() {
  document.documentElement.lang = ext.i18n.getUILanguage();
  for (const element of document.querySelectorAll("[data-i18n]"))
    element.textContent = t(element.dataset.i18n);
  get("version").textContent = t("extensionVersion", VERSION);
}
async function message(payload) {
  const result = await ext.runtime.sendMessage(payload);
  if (result?.error) throw new Error(result.error);
  return result;
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, onClick) {
  const node = element("button", "", text);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}
function savedAt(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  const language = ext.i18n.getUILanguage();
  const time = date.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" });
  return date.toDateString() === new Date().toDateString()
    ? t("lastSavedToday", time)
    : t("lastSavedOn", date.toLocaleDateString(language, { day: "numeric", month: "long" }), time);
}

/** Frame 17: connected is a row; closed, update and missing are cards. */
function renderStatus({ reply, lastSaved }) {
  const status = get("status");
  status.replaceChildren();
  if (reply?.ok) {
    status.dataset.state = "connected";
    const row = element("div", "row");
    const text = element("div", "text");
    const meta = [t("appVersion", reply.version ?? "?"), savedAt(lastSaved)].filter(Boolean).join(" · ");
    text.append(element("p", "title", t("statusConnected")), element("p", "meta", meta));
    row.append(element("span", "dot"), text, button(t("checkAgain"), refreshStatus));
    status.append(row);
    return;
  }
  const state =
    reply?.code === "incompatible_protocol" ? "update" : ["host_missing", "host_failed"].includes(reply?.code) ? "missing" : "closed";
  status.dataset.state = state;
  const older = appIsOlder(reply);
  const [head, text] = {
    closed: [t("statusClosed"), t("statusClosedText")],
    update: older
      ? [t("statusUpdateApp"), t("statusUpdateAppText", reply?.version ?? "?", VERSION)]
      : [t("statusUpdate"), t("statusUpdateText", VERSION, reply?.version ?? "?")],
    missing: [t("statusMissing"), t("statusMissingText")],
  }[state];
  const card = element("div", "state");
  const top = element("div", "head");
  top.append(element("span", "dot"), element("span", "", head));
  card.append(top, element("p", "text", text));
  if (state === "missing") {
    const link = element("a", "button", t("download"));
    link.href = DOWNLOAD;
    link.target = "_blank";
    link.rel = "noopener";
    card.append(link);
  } else {
    card.append(button(t("checkAgain"), refreshStatus));
  }
  status.append(card);
}
async function refreshStatus() {
  try {
    renderStatus(await message({ type: "status" }));
  } catch (error) {
    get("message").textContent = error.message;
  }
}
async function refreshQueue() {
  try {
    const { queue } = await message({ type: "queue" });
    get("count").textContent = String(queue.length);
    get("retry").hidden = !queue.length;
    const list = get("queue");
    list.replaceChildren();
    if (!queue.length) list.append(element("p", "empty", t("queueEmpty")));
    for (const item of queue) {
      const row = element("div", "row");
      const text = element("div", "text");
      text.append(element("p", "title", item.title), element("p", "url", item.url));
      if (item.error) text.append(element("p", "error", item.error));
      const remove = button(t("removeButton"), async () => {
        remove.disabled = true;
        try {
          await message({ type: "remove", request_id: item.request_id });
          await refreshQueue();
        } catch (error) {
          get("message").textContent = error.message;
          remove.disabled = false;
        }
      });
      remove.setAttribute("aria-label", t("removeLabel", item.title));
      row.append(text, remove);
      list.append(row);
    }
  } catch (error) {
    get("message").textContent = error.message;
  }
}
get("retry").addEventListener("click", async () => {
  get("retry").disabled = true;
  get("message").textContent = "";
  try {
    await message({ type: "retry" });
    await Promise.all([refreshQueue(), refreshStatus()]);
  } catch (error) {
    get("message").textContent = error.message;
  } finally {
    get("retry").disabled = false;
  }
});
/** «After saving» (NP-080): both switches are on until the user turns one off. */
async function feedbackSwitches() {
  const { feedback } = await ext.storage.local.get("feedback");
  for (const [key, id] of [
    ["message", "feedback-message"],
    ["animate", "feedback-animate"],
  ]) {
    const box = get(id);
    box.checked = feedback?.[key] !== false;
    box.addEventListener("change", async () => {
      const { feedback: now } = await ext.storage.local.get("feedback");
      await ext.storage.local.set({ feedback: { ...now, [key]: box.checked } });
    });
  }
  // «Show that a page is already saved» (NP-083): off by default; it needs the
  // optional tabs permission, asked for right in the click (Р-41).
  const known = get("feedback-known");
  const tabs = { permissions: ["tabs"] };
  known.checked = feedback?.known === true && (await ext.permissions.contains(tabs));
  known.addEventListener("change", async () => {
    const on = known.checked;
    // Nothing is awaited before the request: the browser asks only inside the click.
    const asked = on ? ext.permissions.request(tabs) : ext.permissions.remove(tabs).then(() => false);
    const granted = await asked.catch(() => false);
    known.checked = on && granted;
    const { feedback: now } = await ext.storage.local.get("feedback");
    await ext.storage.local.set({ feedback: { ...now, known: known.checked } });
  });
}
/**
 * «Keyboard shortcut» (NP-082, sheet 37). Chrome and Edge let only their own
 * page change an extension's shortcut; Firefox lets the extension do it.
 */
const SEARCH_COMMAND = "quick-search";
async function shortcutSection() {
  const browser = browserName();
  const keys = get("shortcut");
  const change = get("shortcut-change");
  const note = get("shortcut-note");
  const show = async () => {
    const shortcut = (await ext.commands.getAll()).find((c) => c.name === SEARCH_COMMAND)?.shortcut ?? "";
    keys.replaceChildren(...(shortcut ? shortcut.split("+").map((key) => element("kbd", "", key)) : [element("span", "meta", t("shortcutNone"))]));
  };
  await show();
  if (browser !== "firefox") {
    const name = browser === "edge" ? "Edge" : "Chrome";
    change.textContent = t("shortcutChangeIn", name);
    note.textContent = t("shortcutNote", name, `${browser}://extensions/shortcuts`);
    change.addEventListener("click", () => void ext.tabs.create({ url: `${browser}://extensions/shortcuts` }));
    return;
  }
  change.textContent = t("shortcutChange");
  let recording = false;
  const stop = (message = "") => {
    recording = false;
    change.textContent = t("shortcutChange");
    change.classList.remove("recording");
    note.textContent = message;
  };
  change.addEventListener("click", () => {
    recording = true;
    change.textContent = t("shortcutPress");
    change.classList.add("recording");
    note.textContent = t("shortcutCancel");
  });
  change.addEventListener("keydown", async (event) => {
    if (!recording) return;
    event.preventDefault();
    if (event.key === "Escape") return stop();
    const shortcut = shortcutFrom(event);
    if (!shortcut) {
      if (!["Control", "Alt", "Shift", "Meta"].includes(event.key)) note.textContent = t("shortcutInvalid");
      return;
    }
    try {
      await ext.commands.update({ name: SEARCH_COMMAND, shortcut });
      stop(t("shortcutSaved"));
      await show();
    } catch {
      stop(t("shortcutRefused", shortcut));
    }
  });
}
// The service worker cannot ask the system about motion; this page can.
const motion = matchMedia("(prefers-reduced-motion: reduce)");
const saveMotion = () => ext.storage.local.set({ reducedMotion: motion.matches });
motion.addEventListener("change", () => void saveMotion());
ext.storage.onChanged.addListener((changes) => {
  if (changes.captureQueue) void refreshQueue();
});
translate();
void feedbackSwitches();
void shortcutSection();
void saveMotion();
void refreshQueue();
void refreshStatus();
