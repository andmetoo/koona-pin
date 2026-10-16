// Native tests on WebKitGTK (NP-095, Р-57): the scenarios of tests/native/native.spec.ts that hold on Linux,
// through tauri-driver and WebKitWebDriver instead of WebView2's CDP. The real binary — the installed package
// in the «distro» jobs — its own library in KOONAPIN_DATA_DIR, the host and the capture socket.
//   bun run test:webkit         (a display or Wayland compositor, a session bus: scripts/linux/ci-webkit.sh)
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

/**
 * A new library opens with the starter links in the inbox (NP-117); the tests are written for an empty
 * library with its first collections, as in tests/native: the links go to the trash and out of it through
 * the app's own commands.
 */
async function emptyLibrary(session) {
  // The first collections and the starter links are made in one transaction.
  await waitFor(() => session.invoke("get_collections"), (c) => c.length > 0, { what: "the new library" });
  const ids = await session.invoke("get_starter_links");
  for (const id of ids) await session.invoke("trash_bookmark", { id });
  if (ids.length > 0) await session.invoke("empty_trash");
}

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
    await emptyLibrary(page);
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
    await (await page.role("button", "New link")).click();
    await (await page.label("Link")).fill("https://example.invalid/native-ui");
    await (await page.role("button", "Title and tags")).click();
    await (await page.label("Title")).fill("SQLite check");
    await (await page.role("button", "Development")).click();
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
    // Only the capture waits in the inbox: the link added by hand went to the library (Development).
    await page.role("button", "Inbox 1");
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
    // From inside the page: the window hides under WebDriver's click, which then may never answer.
    await (await page.role("button", "Hide window")).press();
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
