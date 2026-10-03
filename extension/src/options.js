import { ext, t } from "./ext.js";
import { appIsOlder } from "./native.js";
import { VERSION } from "./version.js";
const get = (id) => document.getElementById(id);
const DOWNLOAD = "https://pin.netami.app";
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
ext.storage.onChanged.addListener((changes) => {
  if (changes.captureQueue) void refreshQueue();
});
translate();
void refreshQueue();
void refreshStatus();
