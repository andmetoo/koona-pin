import { ext, t } from "./ext.js";
import { createQueue } from "./queue.js";
import { PROTOCOL } from "./version.js";
const origin = "http://127.0.0.1:28765";
const alarmName = "netamipin-delivery";
async function badge(text, title, color = "#a34f34", tabId) {
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
    const { captureToken } = await ext.storage.local.get("captureToken");
    if (!captureToken)
      return { ok: false, permanent: false, error: t("errorNoToken") };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${origin}/api/v1/capture`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${captureToken}`,
        },
        body: JSON.stringify({
          request_id: item.request_id,
          url: item.url,
          title: item.title,
        }),
      });
      const body = await response.json();
      if (!response.ok)
        return {
          ok: false,
          permanent:
            response.status >= 400 &&
            response.status < 500 &&
            ![401, 408, 429].includes(response.status),
          error: body.message || t("errorSaveFailed"),
        };
      return { ok: true, ...body };
    } finally {
      clearTimeout(timeout);
    }
  },
});
async function deliver() {
  const results = await queue.flush();
  for (const result of results)
    await badge(
      result.outcome === "existing" ? "=" : "✓",
      result.outcome === "existing" ? t("badgeExisting") : t("badgeSaved"),
      "#426f59",
      result.tabId,
    );
  for (const item of await queue.list()) {
    await badge(
      item.blocked ? "!" : "↗",
      item.error || t("badgeWaiting"),
      item.blocked ? "#af3838" : "#a34f34",
      item.tabId,
    );
  }
  return results;
}
async function initialize() {
  const waiting = await queue.list();
  await updateStatus(waiting);
  if (waiting.length) await deliver();
}
async function captureTab(tab) {
  try {
    await badge("…", t("badgeSaving"), "#a34f34", tab.id);
    const item = await queue.enqueue(tab.url || "", tab.title, tab.id);
    await badge("↗", t("badgeQueued"), "#a34f34", tab.id);
    const results = await deliver();
    const saved = results.find(
      (result) => result.request_id === item.request_id,
    );
    if (saved)
      await badge(
        saved.outcome === "existing" ? "=" : "✓",
        saved.outcome === "existing" ? t("badgeExisting") : t("badgeSaved"),
        "#426f59",
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
          waiting.blocked ? "#af3838" : "#a34f34",
          tab.id,
        );
    }
    const { captureToken } = await ext.storage.local.get("captureToken");
    if (!captureToken) await ext.runtime.openOptionsPage();
  } catch (error) {
    await badge("!", error.message || t("errorSaveFailed"), "#af3838", tab.id);
  }
}
ext.action.onClicked.addListener(captureTab);
ext.runtime.onInstalled.addListener(() => {
  void initialize();
});
ext.runtime.onStartup.addListener(() => {
  void initialize();
});
ext.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === alarmName) void deliver();
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
      case "token": {
        const token = String(message.token || "").trim();
        if (!/^[a-f0-9]{64}$/i.test(token))
          throw new Error(t("errorTokenFormat"));
        await ext.storage.local.set({ captureToken: token });
        await queue.retry();
        await deliver();
        return { ok: true };
      }
      case "health": {
        const { captureToken } = await ext.storage.local.get("captureToken");
        try {
          const r = await fetch(`${origin}/api/health`, {
            headers: captureToken
              ? { Authorization: `Bearer ${captureToken}` }
              : {},
            signal: AbortSignal.timeout(5000),
          });
          const health = await r.json();
          return {
            connected:
              r.ok &&
              health.name === "Netami Pin" &&
              health.protocol === PROTOCOL,
            paired: !!captureToken,
            error: r.status === 401 ? t("errorTokenRejected") : null,
          };
        } catch {
          return { connected: false, paired: !!captureToken };
        }
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
