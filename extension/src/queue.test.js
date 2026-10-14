import { describe, it, expect } from "vitest";
import { createQueue } from "./queue.js";
function setup(
  send = async () => ({ ok: true, bookmark_id: 42, outcome: "created" }),
) {
  const state = {};
  const storage = {
    get: async (key) => ({ [key]: structuredClone(state[key]) }),
    set: async (value) => Object.assign(state, structuredClone(value)),
  };
  let id = 0;
  return {
    state,
    storage,
    queue: createQueue({ storage, send, id: () => `request-${++id}` }),
  };
}
describe("persistent capture queue", () => {
  it("persists before transmission and deduplicates concurrent clicks", async () => {
    const { queue, state } = setup();
    await Promise.all([
      queue.enqueue("https://example.com/", "A"),
      queue.enqueue("https://example.com/", "A"),
    ]);
    expect(state.captureQueue).toHaveLength(1);
  });
  it("survives worker recreation and retains the same request ID after lost response", async () => {
    const { queue, storage } = setup(async () => {
      throw new Error("lost response");
    });
    const first = await queue.enqueue("https://example.com/", "A");
    await queue.flush();
    let received;
    const next = createQueue({
      storage,
      send: async (item) => {
        received = item.request_id;
        return { ok: true, bookmark_id: 42, outcome: "existing" };
      },
    });
    await next.flush();
    expect(received).toBe(first.request_id);
    expect(await next.list()).toEqual([]);
  });
  it("never removes an item on a malformed acknowledgement", async () => {
    const { queue } = setup(async () => ({ ok: true }));
    await queue.enqueue("https://example.com/", "A");
    await queue.flush();
    expect(await queue.list()).toHaveLength(1);
  });
  it("keeps permanent errors visible until explicit retry or removal", async () => {
    const { queue } = setup(async () => ({
      ok: false,
      permanent: true,
      error: "invalid",
    }));
    const first = await queue.enqueue("https://example.com/", "A");
    await queue.flush();
    expect((await queue.list())[0].blocked).toBe(true);
    await queue.retry();
    expect((await queue.list())[0].blocked).toBe(false);
    await queue.remove(first.request_id);
    expect(await queue.list()).toEqual([]);
  });
  it("serializes deletion with delivery so a removed item cannot reappear", async () => {
    const { queue } = setup(async () => ({
      ok: false,
      permanent: false,
      error: "offline",
    }));
    const first = await queue.enqueue("https://example.com/", "A");
    await Promise.all([queue.flush(), queue.remove(first.request_id)]);
    expect(await queue.list()).toEqual([]);
  });
  it("rejects browser-internal pages", async () => {
    const { queue } = setup();
    await expect(
      queue.enqueue("chrome://settings", "Settings"),
    ).rejects.toThrow();
  });
});

describe("Save to Reading in the queue (NP-125)", () => {
  it("keeps the flag while the app is away and sends it on the next delivery", async () => {
    const sent = [];
    const { queue, storage } = setup(async () => ({ ok: false, permanent: false, error: "closed" }));
    const item = await queue.enqueue("https://example.com/a", "A", 3, { reading: true });
    expect(item.reading).toBe(true);
    await queue.flush();
    expect((await queue.list())[0]).toMatchObject({ request_id: item.request_id, reading: true, error: "closed" });
    // A new worker, as after a browser restart, reads the same flag.
    const next = createQueue({
      storage,
      send: async (row) => (sent.push(row), { ok: true, bookmark_id: 7, outcome: "created", reading: true }),
    });
    const [delivered] = await next.flush();
    expect(sent.map((row) => [row.request_id, row.reading])).toEqual([[item.request_id, true]]);
    expect(delivered.reading).toBe(true);
    expect(await next.list()).toEqual([]);
  });

  it("a plain save has no flag; Save to Reading on a waiting link turns it into a new request", async () => {
    const { queue } = setup(async () => ({ ok: false, permanent: false, error: "closed" }));
    const plain = await queue.enqueue("https://example.com/a", "A");
    expect(plain).not.toHaveProperty("reading");
    const reading = await queue.enqueue("https://example.com/a", "", 5, { reading: true });
    expect(reading.reading).toBe(true);
    expect(reading.request_id).not.toBe(plain.request_id);
    expect(reading.title).toBe("A");
    expect(reading.created_at).toBe(plain.created_at);
    expect(await queue.list()).toEqual([reading]);
    // Saved again either way: the waiting request stays as it is.
    expect(await queue.enqueue("https://example.com/a", "A")).toEqual(reading);
    expect(await queue.enqueue("https://example.com/a", "A", 5, { reading: true })).toEqual(reading);
  });
});