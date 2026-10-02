const get = (id) => document.getElementById(id);
async function message(payload) {
  const result = await chrome.runtime.sendMessage(payload);
  if (result?.error) throw new Error(result.error);
  return result;
}
async function refresh() {
  try {
    const [{ queue }, status] = await Promise.all([
      message({ type: "queue" }),
      message({ type: "health" }),
    ]);
    get("count").textContent = String(queue.length);
    get("connection").textContent =
      status.error ||
      (!status.paired
        ? "Вставьте токен, чтобы соединить расширение с приложением."
        : status.connected
          ? "OddClicks запущен. Подключение настроено."
          : "OddClicks закрыт или недоступен. Ссылки останутся в очереди.");
    get("queue").replaceChildren();
    if (!queue.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent =
        "Очередь пуста. Откройте интересную страницу и нажмите значок OddClicks.";
      get("queue").append(empty);
    }
    for (const item of queue) {
      const row = document.createElement("div");
      row.className = "queue-item";
      const content = document.createElement("div");
      const title = document.createElement("p");
      title.className = "queue-title";
      title.textContent = item.title;
      const url = document.createElement("span");
      url.className = "queue-url";
      url.textContent = item.url;
      content.append(title, url);
      if (item.error) {
        const error = document.createElement("p");
        error.className = "queue-error";
        error.textContent = item.error;
        content.append(error);
      }
      const remove = document.createElement("button");
      remove.className = "queue-remove";
      remove.textContent = "Удалить";
      remove.setAttribute("aria-label", `Удалить из очереди: ${item.title}`);
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          await message({ type: "remove", request_id: item.request_id });
          await refresh();
        } catch (error) {
          get("message").textContent = error.message;
          remove.disabled = false;
        }
      });
      row.append(content, remove);
      get("queue").append(row);
    }
  } catch (error) {
    get("message").textContent = error.message;
  }
}
get("pair").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = get("pair").querySelector("button");
  button.disabled = true;
  try {
    await message({ type: "token", token: get("token").value });
    get("token").value = "";
    get("message").textContent =
      "Токен сохранён. Ожидающие ссылки будут переданы приложению.";
    await refresh();
  } catch (error) {
    get("message").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
get("retry").addEventListener("click", async () => {
  get("retry").disabled = true;
  try {
    await message({ type: "retry" });
    await refresh();
  } catch (error) {
    get("message").textContent = error.message;
  } finally {
    get("retry").disabled = false;
  }
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.captureQueue) void refresh();
});
void refresh();
