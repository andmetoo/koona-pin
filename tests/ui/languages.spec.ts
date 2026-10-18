import { test, expect, type Locator, type Page } from "@playwright/test";
import { readdirSync } from "node:fs";
import { type Catalog, catalog, dropPoint, locales, text } from "../fixtures/app";

// Key screens in the longest language and in Serbian (NP-089): snapshots to look at,
// not baselines, and a check that no interface label is cut off.
/** A label as a whole-text pattern: «(», «+», «?» in it are letters. */
const exactly = (label: string, whole = true) =>
  new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${whole ? "$" : ""}`);

/** Interface text that is cut off: wider or taller than its box, with the overflow hidden. Bookmark data may be cut. */
async function cutLabels(page: Page) {
  return page.evaluate(() => {
    const cut: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      if (el.closest("[data-bookmark-id], [data-user-text]") || !el.offsetParent || !el.textContent!.trim()) continue;
      const style = getComputedStyle(el);
      const hides = style.textOverflow === "ellipsis" || style.webkitLineClamp !== "none" || el.classList.contains("fade-end");
      // scrollWidth is rounded: a text 0.4 px too wide gets its ellipsis but not a wider scrollWidth.
      const range = document.createRange();
      range.selectNodeContents(el);
      const room =
        el.getBoundingClientRect().width -
        ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"].reduce((sum, side) => sum + parseFloat(style[side as "paddingLeft"]), 0);
      const wide = range.getBoundingClientRect().width > room + 0.05;
      const tall = style.webkitLineClamp !== "none" && el.scrollHeight > el.clientHeight + 1;
      if (hides && (wide || tall)) cut.push(el.textContent!.trim().slice(0, 80));
    }
    return cut;
  });
}

/**
 * Whether a label's text is cut without an ellipsis: wider than its own box, or reaching past an
 * ancestor that clips (overflow, clip-path) or the window. A nowrap label in a growing box (the
 * capsule) or a button row in a fixed panel is cut this way, and `cutLabels` does not see it.
 */
const clipped = (label: Locator) =>
  label.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const text = range.getBoundingClientRect();
    const boxes: { left: number; right: number }[] = [{ left: 0, right: innerWidth }, el.getBoundingClientRect()];
    for (let node = el.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflowX !== "visible" || style.clipPath !== "none" || node.tagName === "MAIN") boxes.push(node.getBoundingClientRect());
    }
    return boxes.some((box) => text.left < box.left - 0.5 || text.right > box.right + 0.5);
  });

/** A drag of a file from outside over the list area, as a webview shows it before the drop: no name. */
async function dragFile(page: Page, type: "dragenter" | "dragleave") {
  const at = await dropPoint(page);
  await page.evaluate(
    ({ type, at }) => {
      const event = new DragEvent(type, { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y });
      Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [], items: [{ kind: "file", type: "" }], dropEffect: "unset" } });
      (document.elementFromPoint(at.x, at.y) ?? document.body).dispatchEvent(event);
    },
    { type, at },
  );
}

/** A counted string of a catalog as the language says it for `count`. */
const counted = (code: string, key: string, count: number) =>
  text(catalog(code), `${key}_${new Intl.PluralRules(code).select(count)}`).replace(/\{\{\s*count[^}]*\}\}/, String(count));

/** WebKitGTK draws a line 1–5 px wider than Windows (#183): a menu row keeps this much of its width free, the browser status this much of its 144 px slot (Р-52, п. 7). */
const LINUX_SPARE = { row: 7, status: 8 };

// The sidebar shows one browser status of several, and the demo has only one of them: every row's
// words in every language are measured against the row's room in the English layout.
test("sidebar rows fit in every language", { tag: "@languages" }, async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 800 });
  await page.addInitScript(() => localStorage.removeItem("koonapin.demo.v4"));
  await page.goto("/");
  await expect(page.locator("[data-bookmark-id]").first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const en = catalog("en");
  const rows: Record<string, string[]> = {
    "nav.inbox": ["nav.inbox"],
    "nav.all": ["nav.all"],
    "nav.favorites": ["nav.favorites"],
    "nav.trash": ["nav.trash"],
    "nav.settings": ["nav.settings"],
    "browser.notConnected": ["browser.ready", "browser.failing", "browser.checking", "browser.notConnected", "browser.lost", "browser.update", "browser.updateApp"],
  };
  const room: Record<string, { width: number; font: string }> = {};
  for (const key of Object.keys(rows)) {
    const label = page.locator("aside button span.fade-end", { hasText: exactly(text(en, key)) }).first();
    room[key] = await label.evaluate((el) => ({ width: el.clientWidth, font: getComputedStyle(el).font }));
  }
  for (const key of Object.keys(room)) room[key].width -= key === "browser.notConnected" ? LINUX_SPARE.status : LINUX_SPARE.row;
  /** The text as the app shows it: the plural form the language picks for days the status can show. */
  const words = (code: string, key: string): string[] => {
    const [section, name] = key.split(".");
    const node = catalog(code)[section] as Catalog;
    if (typeof node[name] === "string") return [node[name] as string];
    const rules = new Intl.PluralRules(code);
    return [1, 2, 5, 21, 30].map((n) => (node[`${name}_${rules.select(n)}`] as string).replace("{{count}}", String(n)));
  };
  const all = codes.flatMap((code) =>
    Object.entries(rows).flatMap(([row, keys]) =>
      [...new Set(keys.flatMap((key) => words(code, key)))].map((word) => ({ code, row, word, ...room[row] })),
    ),
  );
  // One canvas, one round trip for every word.
  const widths = await page.evaluate(async (all) => {
    // Inter comes in subsets by unicode-range, loaded only for the letters a page shows: the English demo
    // has no Cyrillic, and a canvas would measure the system's fallback font instead.
    await Promise.all(all.map(({ word, font }) => document.fonts.load(font, word)));
    const ctx = document.createElement("canvas").getContext("2d")!;
    return all.map(({ word, font }) => ((ctx.font = font), ctx.measureText(word).width));
  }, all);
  const wide = all
    .map((w, i) => ({ ...w, measured: widths[i] }))
    .filter((w) => w.measured > w.width)
    .map((w) => `${w.code} ${w.row}: «${w.word}» ${Math.ceil(w.measured)} > ${w.width}`);
  expect(wide).toEqual([]);
});

// An IME (Chinese, Japanese, Korean) builds a character over several keys: the list waits for
// the finished one, and Esc inside the IME cancels the character, not the query (NP-090).
test("search and the IME: the list waits for the finished character, Esc inside it keeps the query, a reset wins", { tag: ["@languages", "@chromium"] }, async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem("koonapin.demo.v4"));
  await page.goto("/");
  const cards = page.locator("[data-bookmark-id]");
  await expect(cards.first()).toBeVisible();
  const all = await cards.count();
  const search = page.getByRole("textbox", { name: text(catalog("en"), "toolbar.searchLabel") });

  // Keys inside an IME are the IME's. WebView2 sends them as keyCode 229 or with isComposing; CDP's
  // own key events carry neither, so they are dispatched.
  await search.fill("silence");
  await expect(cards).toHaveCount(1);
  for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
    const sent = await search.evaluate((el, init) => {
      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, ...init });
      el.dispatchEvent(event);
      return { isComposing: event.isComposing, keyCode: event.keyCode };
    }, init);
    // Each event carries only its own sign: the guard must know both.
    expect(sent).toEqual({ isComposing: "isComposing" in init, keyCode: "keyCode" in init ? 229 : 0 });
  }
  await expect(search).toHaveValue("silence");
  await expect(cards).toHaveCount(1);
  // A plain Esc still clears it.
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(cards).toHaveCount(all);

  // A character being composed searches for nothing yet.
  await search.focus();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "けんさく", selectionStart: 4, selectionEnd: 4 });
  await expect(search).toHaveValue("けんさく");
  // Longer than the list's own 150 ms wait: still the whole library.
  await page.waitForTimeout(600);
  await expect(cards).toHaveCount(all);
  await expect(page.getByText(/Nothing matches/)).toHaveCount(0);
  await cdp.send("Input.insertText", { text: "検索" });
  await expect(search).toHaveValue("検索");
  await expect(page.getByText("Nothing matches “検索”")).toBeVisible();

  // A query changed from outside while a character is composed wins: the end of the composition
  // does not bring the old text back.
  await search.fill("zzz");
  await page.getByRole("button", { name: text(catalog("en"), "empty.resetSearch") }).waitFor();
  await search.focus();
  await cdp.send("Input.imeSetComposition", { text: "けん", selectionStart: 2, selectionEnd: 2 });
  await expect(search).toHaveValue("zzzけん");
  // «Clear search» of the empty state, pressed without taking the focus from the field.
  await page.getByRole("button", { name: text(catalog("en"), "empty.resetSearch") }).dispatchEvent("click");
  await expect(search).toHaveValue("");
  await expect(cards).toHaveCount(all);
  await cdp.send("Input.insertText", { text: "" });
  await page.waitForTimeout(400);
  await expect(cards).toHaveCount(all);
});

// A comma ends a tag, the Chinese and Japanese ones too, also when the IME commits it: the
// selection's tag field adds the text before it at once, never a tag with a comma in it.
test("the tag field and commas: a lone one keeps it open, one from an IME ends the tag", { tag: ["@languages", "@chromium"] }, async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem("koonapin.demo.v4"));
  await page.goto("/");
  const cards = page.locator("[data-bookmark-id]");
  await expect(cards.first()).toBeVisible();
  await cards.first().click({ modifiers: ["ControlOrMeta"] });
  await page.getByRole("button", { name: text(catalog("en"), "selection.tag"), exact: true }).click();
  const field = page.getByRole("combobox", { name: text(catalog("en"), "selection.tagLabel") });
  await field.focus();
  const cdp = await page.context().newCDPSession(page);
  // A comma with nothing before it is a slip: the field stays open and empty, nothing is added.
  await cdp.send("Input.imeSetComposition", { text: "，", selectionStart: 1, selectionEnd: 1 });
  await cdp.send("Input.insertText", { text: "，" });
  await expect(field).toBeVisible();
  await expect(field).toHaveValue("");
  await field.press(",");
  await expect(field).toHaveValue("");
  await field.pressSequentially("ux,");
  await expect(page.getByText("Tag «ux» added to 1 bookmark")).toBeVisible();
  // The IME's comma, while composed and when committed, in the field opened again.
  await page.getByRole("button", { name: text(catalog("en"), "selection.tag"), exact: true }).click();
  await field.focus();
  await cdp.send("Input.imeSetComposition", { text: "设计，", selectionStart: 3, selectionEnd: 3 });
  await expect(field).toHaveValue("设计，");
  await cdp.send("Input.insertText", { text: "设计，" });
  await expect(page.getByText("Tag «设计» added to 1 bookmark")).toBeVisible();
});

// Every language is checked for cut labels; German, Serbian, Japanese and Korean also leave
// snapshots to look at.
const codes = readdirSync(locales).map((file) => file.replace(/\.json$/, ""));
const snapshots = ["de", "sr", "ja", "ko"];

for (const code of codes) {
  const t = (key: string) => text(catalog(code), key);
  for (const [width, height] of [
    [800, 550],
    [1600, 800],
  ]) {
    test(`${code} key screens ${width}×${height}`, { tag: "@languages" }, async ({ page }, info) => {
      await page.setViewportSize({ width, height });
      await page.addInitScript((language) => {
        localStorage.removeItem("koonapin.demo.v4");
        localStorage.setItem("koonapin.language", language);
        localStorage.setItem("koonapin.importBanner", "show");
        localStorage.setItem("koonapin.demo.capture", "failing");
      }, code);
      await page.clock.setFixedTime(new Date(2026, 9, 3, 12, 0));
      await page.goto("/");
      await expect(page.locator("[data-bookmark-id]").first()).toBeVisible();
      await page.evaluate(() => document.fonts.ready);

      const found: Record<string, string[]> = {};
      const shot = async (name: string) => {
        found[name] = await cutLabels(page);
        if (!snapshots.includes(code)) return;
        const file = info.outputPath(`${name}.png`);
        await page.screenshot({ path: file, animations: "disabled" });
        await info.attach(name, { path: file, contentType: "image/png" });
      };

      await shot("grid");
      // The notification centre: the bell in the sidebar's header or the strip, its popover in the window.
      await page.locator("[data-notification-bell]").click();
      const centre = page.getByRole("dialog", { name: t("notifications.title") });
      await expect(centre.getByText(exactly(t("inbox.sort")))).toBeVisible();
      await shot("notifications");
      const centreBox = (await centre.boundingBox())!;
      if (centreBox.x + centreBox.width > width || centreBox.y + centreBox.height > height) found["notifications"].push("the centre leaves the window");
      await page.keyboard.press("Escape");

      // The ⋯ menu: «Share as list…» and «Import a file…» (K5).
      await page.getByRole("button", { name: t("toolbar.more"), exact: true }).click();
      const importFile = page.getByRole("menuitem").getByText(t("more.importFile"), { exact: true });
      await expect(importFile).toBeVisible();
      await shot("more-menu");
      if (await clipped(importFile)) found["more-menu"].push(t("more.importFile"));
      await page.keyboard.press("Escape");

      // A file from outside: the drop zone's hero over the list area (K9a).
      await dragFile(page, "dragenter");
      const zone = page.locator("[data-drop-zone]");
      await expect(zone).toHaveAttribute("data-drop-zone", "hero");
      await expect(zone).toContainText(t("add.dropAnything"));
      await shot("drop-zone");
      for (const line of await zone.locator(".drop-zone-words > b, .drop-zone-words > span:not(.drop-zone-icon)").all())
        if (await clipped(line)) found["drop-zone"].push((await line.textContent()) ?? "");
      await dragFile(page, "dragleave");
      await expect(zone).toHaveCount(0);

      // Three bookmarks dragged over the capsule: it widens to say what the drop does (K6a).
      const cards = page.locator("[data-bookmark-id]");
      for (let i = 0; i < 3; i++) await cards.nth(i).locator("h2").first().click({ modifiers: ["ControlOrMeta"] });
      const from = (await cards.first().locator("[data-preview]").boundingBox())!;
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 8, { steps: 3 });
      const capsule = page.locator("[data-bundle-capsule]");
      await expect(capsule).toBeVisible();
      const to = (await capsule.boundingBox())!;
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
      const overLabel = capsule.getByText(counted(code, "drag.bundle", 3), { exact: true });
      await expect(overLabel).toBeVisible();
      // The widening runs 160 ms: wait for the glass to hold the label.
      await expect.poll(() => clipped(overLabel)).toBe(false);
      await shot("bundle-over");
      // The stack's hint says it too, whole: by the capsule the stack goes to the pointer's other side.
      const hint = page.locator("[data-drop-hint] > span");
      await expect(hint).toHaveText(counted(code, "drag.bundle", 3));
      if (await clipped(hint)) found["bundle-over"].push("the drop hint");
      await page.mouse.up();
      await page.keyboard.press("Escape");

      // The panel with the three, then emptied (K7a, K7b).
      await capsule.locator("> button").first().click();
      const panel = page.locator("[data-bundle-panel]");
      await expect(panel.locator("[data-bundle-row]")).toHaveCount(3);
      await shot("bundle-panel");
      for (const key of ["bundle.copy", "bundle.save"]) {
        const button = panel.getByRole("button", { name: t(key), exact: true });
        if (await clipped(button)) found["bundle-panel"].push(t(key));
      }
      await panel.getByRole("button", { name: t("bundle.clear"), exact: true }).click();
      await expect(panel.locator("[data-bundle-empty]")).toBeVisible();
      await shot("bundle-empty");
      const addView = panel.locator("[data-bundle-empty] button").first();
      if (await clipped(addView)) found["bundle-empty"].push("the empty state's button");
      // Clear hands the focus to the empty state's button a frame later; Esc goes from there.
      await expect(addView).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);

      await page.getByRole("button", { name: t("toolbar.list"), exact: true }).click();
      await shot("list");

      await page.locator("[data-bookmark-id]").first().click({ modifiers: ["ControlOrMeta"] });
      await page.locator("[data-bookmark-id]").nth(1).click({ modifiers: ["ControlOrMeta"] });
      await shot("selection");
      // The bar keeps its 740 px (NP-123 put «Read · Space» first): its buttons fit inside, «×» too.
      const bar = page.getByRole("toolbar", { name: t("selection.label") });
      const barBox = (await bar.boundingBox())!;
      const clearBox = (await bar.getByRole("button", { name: t("selection.clear") }).boundingBox())!;
      if (clearBox.x + clearBox.width > barBox.x + barBox.width - 7) found["selection"].push("the selection bar overflows");
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: t("sidebar.newLink") }).first().click();
      await shot("add-dialog");
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: exactly(t("nav.inbox"), false) }).first().click();
      await page.getByRole("button", { name: t("inbox.sort"), exact: true }).first().click();
      await shot("triage");
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: t("nav.settings") }).first().click();
      await shot("settings");

      expect(found).toEqual(Object.fromEntries(Object.keys(found).map((k) => [k, []])));
    });
  }
}
