import { createQueue } from "./queue.js";
const origin = "http://127.0.0.1:28765";
const alarmName = "netamipin-delivery";
async function badge(text, title, color = "#a34f34", tabId) {
  const scope = Number.isInteger(tabId) ? { tabId } : {};
  try {
    await chrome.action.setBadgeText({ ...scope, text });
    await chrome.action.setBadgeBackgroundColor({ ...scope, color });
    await chrome.action.setTitle({ ...scope, title });
  } catch {
    /* A tab may have closed since capture. */
  }
}
async function updateStatus(queue) {
  if (queue.length) {
    await chrome.alarms.create(alarmName, { periodInMinutes: 1 });
    await badge(
      queue.some((item) => item.blocked) ? "!" : String(queue.length),
      `Netami Pin: ожидают передачи ${queue.length}. Откройте настройки для просмотра очереди.`,
    );
  } else {
    await chrome.alarms.clear(alarmName);
    await badge("", "Сохранить страницу в Netami Pin");
  }
}
const queue = createQueue({
  storage: chrome.storage.local,
  changed: updateStatus,
  send: async (item) => {
    const { captureToken } = await chrome.storage.local.get("captureToken");
    if (!captureToken)
      return {
        ok: false,
        permanent: false,
        error: "Подключите расширение: вставьте локальный токен в настройках.",
      };
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
          error: body.message || "Не удалось сохранить ссылку",
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
      result.outcome === "existing"
        ? "Эта ссылка уже есть в Netami Pin"
        : "Сохранено в Netami Pin",
      "#426f59",
      result.tabId,
    );
  for (const item of await queue.list()) {
    await badge(
      item.blocked ? "!" : "↗",
      item.error || "Ссылка ожидает передачи в Netami Pin",
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
    await badge("…", "Сохраняется в Netami Pin", "#a34f34", tab.id);
    const item = await queue.enqueue(tab.url || "", tab.title, tab.id);
    await badge("↗", "Ссылка в локальной очереди Netami Pin", "#a34f34", tab.id);
    const results = await deliver();
    const saved = results.find(
      (result) => result.request_id === item.request_id,
    );
    if (saved)
      await badge(
        saved.outcome === "existing" ? "=" : "✓",
        saved.outcome === "existing"
          ? "Эта ссылка уже есть в Netami Pin"
          : "Сохранено в Netami Pin",
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
          waiting.error || "Ссылка ожидает передачи в Netami Pin",
          waiting.blocked ? "#af3838" : "#a34f34",
          tab.id,
        );
    }
    const { captureToken } = await chrome.storage.local.get("captureToken");
    if (!captureToken) await chrome.runtime.openOptionsPage();
  } catch (error) {
    await badge(
      "!",
      error.message || "Не удалось сохранить ссылку",
      "#af3838",
      tab.id,
    );
  }
}
chrome.action.onClicked.addListener(captureTab);
chrome.runtime.onInstalled.addListener(() => {
  void initialize();
});
chrome.runtime.onStartup.addListener(() => {
  void initialize();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === alarmName) void deliver();
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (
    sender.id !== chrome.runtime.id ||
    !sender.url?.startsWith(chrome.runtime.getURL(""))
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
          throw new Error(
            "Скопируйте полный токен из Netami Pin → Подключить браузер.",
          );
        await chrome.storage.local.set({ captureToken: token });
        await queue.retry();
        await deliver();
        return { ok: true };
      }
      case "health": {
        const { captureToken } = await chrome.storage.local.get("captureToken");
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
              r.ok && health.name === "Netami Pin" && health.protocol === 1,
            paired: !!captureToken,
            error:
              r.status === 401
                ? "Токен не подходит. Скопируйте актуальный токен из Netami Pin."
                : null,
          };
        } catch {
          return { connected: false, paired: !!captureToken };
        }
      }
      default:
        throw new Error("Неизвестное действие");
    }
  };
  handle()
    .then(respond)
    .catch((error) => respond({ error: error.message }));
  return true;
});
// The alarm had this name before the rename to Netami Pin.
void chrome.alarms.clear("oddclicks-delivery");
// Recreate the alarm after worker restarts: Chrome does not guarantee its persistence.
void queue.list().then(updateStatus).catch(console.error);
