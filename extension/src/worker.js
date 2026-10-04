import { ext, t } from "./ext.js";
import { failure, talk } from "./native.js";
import { createQueue } from "./queue.js";
import { onMenuClicked, registerMenu } from "./menu.js";
const alarmName = "netamipin-delivery";
// The app counts a browser as connected while it hears from it within three
// days (NP-016); a hello twice a day keeps that true without any saving.
const helloAlarm = "netamipin-hello";
const HELLO_MINUTES = 12 * 60;
async function badge(text, title, color = "#2f6b4f", tabId) {
  const scope = Number.isInteger(tabId) ? { tabId } : {};
  try {
    await ext.action.setBadgeText({ ...scope, text });
    await ext.action.setBadgeBackgroundColor({ ...scope, color });
    await ext.action.setTitle({ ...scope, title });
  } catch {
    /* A tab may have closed since capture. */
  }
}
async function updateStatus(queue) {
  if (queue.length) {
    await ext.alarms.create(alarmName, { periodInMinutes: 1 });
    await badge(
      queue.some((item) => item.blocked) ? "!" : String(queue.length),
      t("queueWaiting", queue.length),
      "#b59a45",
    );
  } else {
    await ext.alarms.clear(alarmName);
    await badge("", t("actionTitle"));
  }
}
const queue = createQueue({
  storage: ext.storage.local,
  changed: updateStatus,
  send: async (item) => {
    const reply = await talk({
      type: "capture",
      request_id: item.request_id,
      url: item.url,
      title: item.title,
    });
    if (!reply.ok) return { ok: false, code: reply.code, ...failure(reply) };
    await ext.storage.local.set({ lastSaved: new Date().toISOString() });
    return { ok: true, bookmark_id: reply.bookmark_id, outcome: reply.outcome };
  },
});
async function deliver() {
  const results = await queue.flush();
  for (const result of results)
    await badge(
      result.outcome === "existing" ? "=" : "✓",
      result.outcome === "existing" ? t("badgeExisting") : t("badgeSaved"),
      "#2f6b4f",
      result.tabId,
    );
  for (const item of await queue.list()) {
    await badge(
      item.blocked ? "!" : "↗",
      item.error || t("badgeWaiting"),
      item.blocked ? "#af3838" : "#b59a45",
      item.tabId,
    );
  }
  return results;
}
/** Tells the app this browser is here; a hello never starts a closed app. */
async function hello() {
  const reply = await talk({ type: "hello" });
  await ext.storage.local.set({ lastHello: { at: new Date().toISOString(), reply } });
  return reply;
}
async function initialize() {
  await registerMenu(ext.menus).catch(console.error);
  await ext.alarms.create(helloAlarm, { periodInMinutes: HELLO_MINUTES });
  await hello();
  const waiting = await queue.list();
  await updateStatus(waiting);
  if (waiting.length) await deliver();
}
async function captureTab(tab) {
  try {
    await badge("…", t("badgeSaving"), "#2f6b4f", tab.id);
    const item = await queue.enqueue(tab.url || "", tab.title, tab.id);
    await badge("↗", t("badgeQueued"), "#b59a45", tab.id);
    const results = await deliver();
    const saved = results.find(
      (result) => result.request_id === item.request_id,
    );
    if (saved)
      await badge(
        saved.outcome === "existing" ? "=" : "✓",
        saved.outcome === "existing" ? t("badgeExisting") : t("badgeSaved"),
        "#2f6b4f",
        tab.id,
      );
    else {
      const waiting = (await queue.list()).find(
        (row) => row.request_id === item.request_id,
      );
      if (waiting)
        await badge(
          waiting.blocked ? "!" : "↗",
          waiting.error || t("badgeWaiting"),
          waiting.blocked ? "#af3838" : "#b59a45",
          tab.id,
        );
      // Without the app nothing will ever be delivered: show why.
      if (waiting?.code === "host_missing") await ext.runtime.openOptionsPage();
    }
  } catch (error) {
    await badge("!", error.message || t("errorSaveFailed"), "#af3838", tab.id);
  }
}
ext.action.onClicked.addListener(captureTab);
ext.menus?.onClicked.addListener((info) => onMenuClicked(info, () => ext.runtime.openOptionsPage()));
ext.runtime.onInstalled.addListener(() => {
  void initialize();
});
ext.runtime.onStartup.addListener(() => {
  void initialize();
});
ext.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === alarmName) void deliver();
  if (alarm.name === helloAlarm) void hello();
});
ext.runtime.onMessage.addListener((message, sender, respond) => {
  if (
    sender.id !== ext.runtime.id ||
    !sender.url?.startsWith(ext.runtime.getURL(""))
  )
    return;
  const handle = async () => {
    switch (message.type) {
      case "queue":
        return { queue: await queue.list() };
      case "remove":
        await queue.remove(message.request_id);
        return { ok: true };
      case "retry":
        await queue.retry();
        await deliver();
        return { ok: true };
      case "status": {
        const reply = await hello();
        const { lastSaved } = await ext.storage.local.get("lastSaved");
        return { reply, lastSaved: lastSaved ?? null };
      }
      default:
        throw new Error(t("errorUnknownAction"));
    }
  };
  handle()
    .then(respond)
    .catch((error) => respond({ error: error.message }));
  return true;
});
// Recreate the alarm after worker restarts: Chrome does not guarantee its persistence.
void queue.list().then(updateStatus).catch(console.error);
