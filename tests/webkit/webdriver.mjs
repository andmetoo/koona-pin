// A W3C WebDriver client for the WebKitGTK tests (NP-095, Р-56): tauri-driver in front of WebKitWebDriver,
// the way Tauri documents it. No npm package: the «distro» jobs of linux.yml have Node and no node_modules,
// and the handful of commands below is all the tests use. Elements are found the way Playwright finds them
// in tests/native — by role and accessible name, or by label — through a script in the page.
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import net from "node:net";

const W3C_ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
const BACKSPACE = "";

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `read` until `accept` holds, like expect.poll: the last value and error go into the failure. */
export async function waitFor(read, accept = Boolean, { timeout = 15000, what = "condition" } = {}) {
  const until = Date.now() + timeout;
  let last;
  let error;
  for (;;) {
    try {
      last = await read();
      error = undefined;
      if (accept(last)) return last;
    } catch (caught) {
      error = caught;
    }
    if (Date.now() > until)
      throw new Error(`Timed out after ${timeout} ms waiting for ${what}; last: ${JSON.stringify(last)}${error ? `; ${error.message}` : ""}`);
    await sleep(100);
  }
}

/**
 * Starts tauri-driver on free ports; it starts WebKitWebDriver, which starts the app of each session with
 * the driver's environment — so `env` is the app's environment too (KOONAPIN_DATA_DIR, the pipe).
 */
export async function startDriver(env, log) {
  const port = await freePort();
  const nativePort = await freePort();
  // The app's stderr comes through the drivers: GTK warns there for every key under Weston headless.
  const driver = spawn(process.env.KOONAPIN_TAURI_DRIVER || "tauri-driver", ["--port", String(port), "--native-port", String(nativePort)], {
    env,
    stdio: ["ignore", "ignore", openSync(log, "a")],
  });
  const url = `http://127.0.0.1:${port}`;
  await waitFor(
    async () => (await fetch(`${url}/status`)).ok,
    Boolean,
    { timeout: 10000, what: "tauri-driver to answer" },
  );
  return {
    url,
    stop: () => driver.kill(),
  };
}

async function call(base, method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const { value } = await response.json();
  if (!response.ok) throw new Error(`WebDriver ${method} ${path}: ${value?.error}: ${value?.message}`);
  return value;
}

// In the page: the elements of a role, or the controls of a label, with their accessible names.
const FIND = `
const [kind, role, name, exact] = arguments;
const norm = (s) => (s ?? "").replace(/\\s+/g, " ").trim();
const text = (id) => norm(document.getElementById(id)?.textContent);
const label = (el) =>
  norm(el.getAttribute("aria-label")) ||
  (el.getAttribute("aria-labelledby") ?? "").split(" ").filter(Boolean).map(text).join(" ") ||
  norm(el.labels?.[0]?.textContent);
// Text of the descendants with a space between elements, as an accessible name reads «Inbox» and its badge.
const content = (el) => {
  const parts = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) parts.push(walker.currentNode.data);
  return norm(parts.join(" "));
};
const accessible = (el) => label(el) || content(el) || norm(el.getAttribute("title"));
const roles = {
  button: "button, [role=button]",
  heading: "h1, h2, h3, h4, h5, h6, [role=heading]",
  textbox: "input:not([type]), input[type=text], input[type=search], input[type=url], textarea, [role=textbox]",
  dialog: "dialog, [role=dialog], [role=alertdialog]",
  menuitem: "[role=menuitem]",
  region: "section[aria-label], section[aria-labelledby], [role=region]",
  switch: "[role=switch]",
};
const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
const matches = (value) => (exact ? value === name : value.toLowerCase().includes(name.toLowerCase()));
const candidates = kind === "label" ? document.querySelectorAll("input, textarea, select") : document.querySelectorAll(roles[role]);
return [...candidates].filter((el) => visible(el) && matches(kind === "label" ? label(el) : accessible(el)));
`;

export class Session {
  constructor(base, id) {
    this.base = base;
    this.id = id;
  }

  static async create(driverUrl, application, args = []) {
    const value = await call(driverUrl, "POST", "/session", {
      capabilities: { alwaysMatch: { "tauri:options": { application, args } } },
    });
    return new Session(driverUrl, value.sessionId);
  }

  cmd(method, path, body) {
    return call(this.base, method, `/session/${this.id}${path}`, body);
  }

  delete() {
    return call(this.base, "DELETE", `/session/${this.id}`).catch(() => {});
  }

  script(source, ...args) {
    return this.cmd("POST", "/execute/sync", { script: source, args });
  }

  /** A Tauri command through the page's IPC, as tests/native call it. */
  async invoke(command, args = {}) {
    const result = await this.cmd("POST", "/execute/async", {
      script: `const done = arguments[arguments.length - 1];
        window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then((value) => done({ value }), (error) => done({ error }));`,
      args: [command, args],
    });
    if ("error" in result) throw new Error(`${command}: ${JSON.stringify(result.error)}`);
    return result.value;
  }

  async all(kind, role, name, exact) {
    return (await this.script(FIND, kind, role, name, exact)).map((ref) => new Element(this, ref[W3C_ELEMENT]));
  }

  /** The one visible element of a role and accessible name; waits for it like a Playwright locator. */
  role(role, name, { exact = true, timeout } = {}) {
    return waitFor(
      async () => (await this.all("role", role, name, exact))[0],
      Boolean,
      { timeout, what: `${role} «${name}»` },
    );
  }

  label(name, { timeout } = {}) {
    return waitFor(async () => (await this.all("label", null, name, true))[0], Boolean, { timeout, what: `field «${name}»` });
  }

  /** Waits until `count` elements match the CSS selector. */
  count(css, count, { timeout } = {}) {
    return waitFor(
      () => this.script("return document.querySelectorAll(arguments[0]).length", css),
      (n) => n === count,
      { timeout, what: `${count} × ${css}` },
    );
  }

  text(css) {
    return this.script("return [...document.querySelectorAll(arguments[0])].map((e) => e.textContent).join('\\n')", css);
  }

  screenshot() {
    return this.cmd("GET", "/screenshot").then((png) => Buffer.from(png, "base64"));
  }
}

export class Element {
  constructor(session, id) {
    this.session = session;
    this.id = id;
  }

  click() {
    return this.session.cmd("POST", `/element/${this.id}/click`, {});
  }

  /**
   * Replaces the field's text with keys, as a user does: select all, then type over it. WebDriver's own
   * «clear» sets the value without an input event, and React keeps the old one.
   */
  async fill(value) {
    await this.session.script("arguments[0].focus(); arguments[0].select()", { [W3C_ELEMENT]: this.id });
    await this.session.cmd("POST", `/element/${this.id}/value`, { text: value || BACKSPACE });
  }

  /** A <select> option by its visible text, through a click on the option as a user picks it. */
  async select(label) {
    const option = await this.session.script(
      "return [...arguments[0].options].find((o) => o.textContent.trim() === arguments[1]) ?? null",
      { [W3C_ELEMENT]: this.id },
      label,
    );
    if (!option) throw new Error(`no option «${label}»`);
    return this.session.cmd("POST", `/element/${option[W3C_ELEMENT]}/click`, {});
  }

  text() {
    return this.session.cmd("GET", `/element/${this.id}/text`);
  }
}
