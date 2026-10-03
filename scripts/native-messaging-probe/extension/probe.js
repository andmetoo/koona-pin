// The Chrome and Edge service worker, and the script of probe.html in Firefox.
// run.mjs calls globalThis.probe from outside and reads the results.
const api = globalThis.browser ?? globalThis.chrome;
const host = "app.netami.pin.probe";

globalThis.probe = {
  /** One message, one host process (runtime.sendNativeMessage). */
  async send(message, name = host) {
    const start = performance.now();
    try {
      const reply = await api.runtime.sendNativeMessage(name, message);
      return { reply, ms: performance.now() - start };
    } catch (error) {
      return {
        error: String(error?.message ?? error),
        ms: performance.now() - start,
      };
    }
  },
  /** Several captures over one long-lived host (runtime.connectNative). */
  async port(count) {
    const start = performance.now();
    const port = api.runtime.connectNative(host);
    const times = [];
    let hostPid;
    try {
      for (let i = 0; i < count; i++) {
        const sent = performance.now();
        const reply = await new Promise((resolve, reject) => {
          const cleanup = () => {
            port.onMessage.removeListener(onMessage);
            port.onDisconnect.removeListener(onDisconnect);
          };
          const onMessage = (message) => {
            cleanup();
            resolve(message);
          };
          const onDisconnect = (p) => {
            cleanup();
            reject(
              new Error(
                p?.error?.message ??
                  api.runtime.lastError?.message ??
                  "disconnected",
              ),
            );
          };
          port.onMessage.addListener(onMessage);
          port.onDisconnect.addListener(onDisconnect);
          port.postMessage({
            cmd: "capture",
            url: `https://example.invalid/port/${i}`,
          });
        });
        times.push(performance.now() - sent);
        hostPid = reply.host.pid;
      }
    } finally {
      port.disconnect();
    }
    return { times, hostPid, total: performance.now() - start };
  },
};
