import { t } from "./ext.js";

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
  // Safari can refuse even a tiny write with «Exceeded storage quota» (NP-119,
  // #315). The link must not depend on it: a write that fails leaves the queue
  // in memory, which delivery uses until a later write succeeds. Only a link
  // that is neither delivered nor stored is lost, when the worker unloads.
  let unsaved = null;
  const read = async () =>
    unsaved ?? ((await storage.get("captureQueue")).captureQueue || []);
  const write = async (queue) => {
    try {
      await storage.set({ captureQueue: queue });
      unsaved = null;
    } catch (error) {
      console.warn("Capture queue kept in memory:", error?.message ?? error);
      unsaved = queue;
    }
    await changed(queue);
  };
  return {
    list: () => exclusive(read),
    /** Whether the queue on disk is behind the one in memory. */
    stored: () => unsaved === null,
    // `reading`: «Save to Reading» (NP-125); the flag waits in the queue with
    // the link, so a link saved while the app was closed still lands there.
    enqueue: (url, title, tabId, { reading = false } = {}) =>
      exclusive(async () => {
        let parsed;
        try {
          parsed = new URL(url);
        } catch {
          throw new Error(t("errorInvalidUrl"));
        }
        if (!["http:", "https:"].includes(parsed.protocol))
          throw new Error(t("errorUnsupportedScheme"));
        const queue = await read();
        const existing = queue.find((item) => item.url === url);
        if (existing && (existing.reading || !reading)) return existing;
        // Waiting without the flag and now saved to Reading: a new request, so
        // a receipt the app may already hold for the old one does not answer it.
        const item = {
          request_id: id(),
          url,
          title: title || existing?.title || parsed.hostname,
          tabId,
          created_at: existing?.created_at ?? new Date().toISOString(),
          error: null,
          blocked: false,
          ...(reading ? { reading: true } : {}),
        };
        await write(
          existing
            ? queue.map((row) => (row.request_id === existing.request_id ? item : row))
            : [...queue, item],
        );
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
              error: t("errorUnavailable"),
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
                    error: result.error || t("errorNoConfirmation"),
                    code: result.code ?? null,
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
