/** All mutations, including deletion from the options page, pass through one worker. */
export function createQueue({
  storage,
  send,
  id = () => crypto.randomUUID(),
  changed = async () => {},
}) {
  let chain = Promise.resolve();
  const exclusive = (operation) => {
    const result = chain.then(operation);
    chain = result.catch(() => {});
    return result;
  };
  const read = async () =>
    (await storage.get("captureQueue")).captureQueue || [];
  const write = async (queue) => {
    await storage.set({ captureQueue: queue });
    await changed(queue);
  };
  return {
    list: () => exclusive(read),
    enqueue: (url, title, tabId) =>
      exclusive(async () => {
        let parsed;
        try {
          parsed = new URL(url);
        } catch {
          throw new Error(
            "Эту страницу нельзя сохранить. Откройте страницу с адресом HTTP/HTTPS.",
          );
        }
        if (!["http:", "https:"].includes(parsed.protocol))
          throw new Error(
            "Эту страницу нельзя сохранить. Поддерживаются только ссылки HTTP/HTTPS.",
          );
        const queue = await read();
        const existing = queue.find((item) => item.url === url);
        if (existing) return existing;
        const item = {
          request_id: id(),
          url,
          title: title || parsed.hostname,
          tabId,
          created_at: new Date().toISOString(),
          error: null,
          blocked: false,
        };
        await write([...queue, item]);
        return item;
      }),
    remove: (requestId) =>
      exclusive(async () => {
        await write(
          (await read()).filter((item) => item.request_id !== requestId),
        );
      }),
    retry: () =>
      exclusive(async () => {
        await write(
          (await read()).map((item) => ({
            ...item,
            blocked: false,
            error: null,
          })),
        );
      }),
    flush: () =>
      exclusive(async () => {
        let queue = await read();
        const results = [];
        for (const item of [...queue]) {
          if (item.blocked) continue;
          let result;
          try {
            result = await send(item);
          } catch {
            result = {
              ok: false,
              permanent: false,
              error: "OddClicks недоступен. Ссылка ожидает передачи.",
            };
          }
          if (
            result.ok &&
            Number.isInteger(result.bookmark_id) &&
            ["created", "existing"].includes(result.outcome)
          ) {
            queue = queue.filter((row) => row.request_id !== item.request_id);
            results.push({
              ...result,
              request_id: item.request_id,
              tabId: item.tabId,
            });
          } else {
            queue = queue.map((row) =>
              row.request_id === item.request_id
                ? {
                    ...row,
                    error:
                      result.error || "Подтверждение сохранения не получено",
                    blocked: !!result.permanent,
                  }
                : row,
            );
          }
          await write(queue);
          // Network, server and pairing failures should not generate a burst of requests.
          if (!result.ok && !result.permanent) break;
        }
        return results;
      }),
  };
}
