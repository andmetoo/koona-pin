import { describe, it, expect } from "vitest";
import { appIsOlder, browserName, failure, talk } from "./native.js";
import { HOST, PROTOCOL, VERSION } from "./version.js";

describe("native messaging", () => {
  it("tells Chrome, Edge and Firefox apart", () => {
    expect(browserName({ navigator: { userAgentData: { brands: [{ brand: "Google Chrome" }] } } })).toBe("chrome");
    expect(browserName({ navigator: { userAgentData: { brands: [{ brand: "Microsoft Edge" }] } } })).toBe("edge");
    expect(browserName({ browser: { runtime: { getBrowserInfo() {} } }, navigator: {} })).toBe("firefox");
    expect(browserName({})).toBe("chrome");
  });

  it("sends the protocol, version and host name with every message", async () => {
    let sent;
    const reply = await talk({ type: "hello" }, {
      sendNativeMessage: async (host, message) => {
        sent = { host, message };
        return { ok: true };
      },
    });
    expect(reply.ok).toBe(true);
    expect(sent.host).toBe(HOST);
    expect(sent.message).toMatchObject({ type: "hello", protocol: PROTOCOL, version: VERSION });
  });

  it("turns the browser's errors into codes and never throws", async () => {
    const failing = (text) => ({ sendNativeMessage: async () => Promise.reject(new Error(text)) });
    expect((await talk({}, failing("Specified native messaging host not found."))).code).toBe("host_missing");
    expect((await talk({}, failing("Access to the specified native messaging host is forbidden."))).code).toBe("host_missing");
    expect((await talk({}, failing("No such native application app.koona.pin"))).code).toBe("host_missing");
    expect((await talk({}, failing("Native host has exited."))).code).toBe("host_failed");
  });

  it("keeps a link in the queue unless the app refuses it for good", () => {
    expect(failure({ code: "app_unavailable" }).permanent).toBe(false);
    expect(failure({ code: "host_missing" }).permanent).toBe(false);
    expect(failure({ code: "incompatible_protocol", protocol: PROTOCOL + 1 }).permanent).toBe(false);
    expect(failure({ code: "database_error" }).permanent).toBe(false);
    expect(failure({ code: "invalid_request" }).permanent).toBe(true);
    expect(failure({ code: "request_id_conflict" }).permanent).toBe(true);
    expect(appIsOlder({ code: "incompatible_protocol", protocol: PROTOCOL - 1 })).toBe(true);
    expect(appIsOlder({ code: "incompatible_protocol", protocol: PROTOCOL + 1 })).toBe(false);
  });
});
