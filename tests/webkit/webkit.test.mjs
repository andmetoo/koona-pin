// Native tests on WebKitGTK (NP-095, Р-57): the scenarios of tests/native/native.spec.ts that hold on Linux,
// through tauri-driver and WebKitWebDriver instead of WebView2's CDP. The real binary — the installed package
// in the «distro» jobs — its own library in KOONAPIN_DATA_DIR, the host and the capture socket.
//   node --test tests/webkit/      (a display or Wayland compositor, a session bus: scripts/linux/ci-webkit.sh)
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { appBinary, assertNoOtherApp, capture, hostMessage, testPipe } from "../../scripts/lib/native-host.mjs";
import { Session, startDriver, waitFor } from "./webdriver.mjs";

const app = existsSync("/usr/bin/koonapin") && !process.env.KOONAPIN_TEST_BINARY ? "/usr/bin/koonapin" : appBinary();
const host = path.join(path.dirname(app), "koonapin-host");
const isVisible = (session) => session.invoke("plugin:window|is_visible");

describe(`WebKitGTK: ${app} under ${process.env.WAYLAND_DISPLAY ? "Wayland" : "X11"}`, () => {
  const data = path.resolve(".test-data", `webkit-${process.env.WAYLAND_DISPLAY ? "wayland" : "x11"}-${Date.now()}`);
  const env = { ...process.env, KOONAPIN_DATA_DIR: data, KOONAPIN_PIPE: testPipe("webkit") };
  let driver;
  let page;

  before(async () => {
    assertNoOtherApp();
    await mkdir(data, { recursive: true });
    driver = await startDriver(env, path.join(data, "driver.log"));
    page = await Session.create(driver.url, app);
  });

  after(async () => {
    try {
      await writeFile(path.join(data, "last.png"), await page.screenshot());
    } catch {
      // The window may be gone with the test that failed.
    }
    await page?.delete();
    driver?.stop();
  });

  it("starts with its library in KOONAPIN_DATA_DIR", async () => {
    await page.role("heading", "Your bookmarks will live here");
    assert.ok(existsSync(path.join(data, "koonapin.db")), "koonapin.db in KOONAPIN_DATA_DIR");
    // A new library speaks English: its first collections are named by the interface (NP-085).
    const names = await waitFor(
      async () => (await page.invoke("get_collections")).map((c) => c.name),
      (n) => n.length === 3,
      { what: "the first collections" },
    );
    assert.deepEqual(names, ["Articles / To read", "Design & UI", "Development"]);
  });

  it("adds a link by hand into SQLite", async () => {
    await (await page.role("button", "Add link")).click();
    await (await page.label("Link")).fill("https://example.invalid/native-ui");
    await (await page.label("Title")).fill("SQLite check");
    await (await page.label("Collection")).select("Development");
    await (await page.role("button", "Save link")).click();
    await page.count("[data-bookmark-id]", 1);
    assert.equal((await page.invoke("get_counts")).total, 1);
  });

  it("shows the capture status: a capture through the host connects the browser", async () => {
    await page.role("button", "No browser yet");
    const { reply } = await hostMessage(capture("webkit-incoming", "https://example.invalid/native-host", "From the browser", "firefox"), {
      env,
      host,
    });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.outcome, "created");
    await page.count("[data-bookmark-id]", 2);
    await page.role("button", "Browser connected");
    // Both wait in the inbox: the link added by hand and the capture.
    await page.role("button", "Inbox 2");
  });

  it("searches through FTS5: case folds, every word", async () => {
    const search = await page.role("textbox", "Search the library");
    await search.fill("BROWSER native");
    await page.count("[data-bookmark-id]", 1);
    assert.match(await page.text("[data-bookmark-id]"), /From the browser/);
    await search.fill("");
    await page.count("[data-bookmark-id]", 2);
  });

  it("without a tray the window hides on close; a second start hands over and shows it", async () => {
    await (await page.role("button", "Close window")).click();
    // A container has no StatusNotifierWatcher: the first close says the app keeps running (Р-52).
    await page.role("dialog", "Koona Pin keeps running");
    await (await page.role("button", "Hide window")).click();
    await waitFor(() => isVisible(page), (v) => v === false, { what: "the window to hide" });
    const second = spawn(app, [], { env, stdio: "ignore" });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        second.kill();
        reject(new Error("the second start did not exit"));
      }, 15000);
      second.on("exit", (status) => {
        clearTimeout(timer);
        resolve(status);
      });
    });
    assert.equal(code, 0);
    await waitFor(() => isVisible(page), (v) => v === true, { what: "the first window to come back" });
    await page.count("[data-bookmark-id]", 2);
  });
});
