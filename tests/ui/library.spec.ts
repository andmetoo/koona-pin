import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.removeItem("netamipin.demo.v2"));
  await page.reload();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(6);
});
test("hover keeps card and preview geometry stable", async ({ page }) => {
  const card = page.locator('[data-bookmark-id="1"]');
  const before = await card.boundingBox();
  const image = await card.locator("[data-preview]").boundingBox();
  await card.hover();
  await page.waitForTimeout(220);
  expect(await card.boundingBox()).toEqual(before);
  expect(await card.locator("[data-preview]").boundingBox()).toEqual(image);
});
test("search, favorites and list view", async ({ page }) => {
  await page.getByRole("textbox", { name: "Поиск в библиотеке" }).fill("АРХИТЕКТУРА");
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(1);
  await page.getByRole("textbox", { name: "Поиск в библиотеке" }).fill("");
  await page.getByRole("button", { name: "Избранное 2" }).click();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(2);
  await page.getByRole("button", { name: "Список", exact: true }).click();
  await expect(page.locator('[data-view="list"]')).toBeVisible();
});
test("dialog restores focus and editor persists collection clearing", async ({ page }) => {
  const add = page.getByRole("button", { name: "Добавить ссылку", exact: true });
  await add.click();
  await page.keyboard.press("Escape");
  await expect(add).toBeFocused();
  await page.locator('[data-bookmark-id="1"]').hover();
  await page.getByRole("button", { name: /^Действия:/ }).first().click();
  await page.getByRole("menuitem", { name: "Изменить…" }).click();
  await page.getByLabel("Коллекция", { exact: true }).selectOption("");
  await page.getByRole("button", { name: "Сохранить изменения" }).click();
  await page.getByRole("button", { name: "Список", exact: true }).click();
  await expect(page.locator('[data-bookmark-id="1"] [data-collection]')).toContainText("Без коллекции");
});
test("card menu moves a bookmark to a collection with the keyboard", async ({ page }) => {
  await page.locator('[data-bookmark-id="2"]').hover();
  await page.getByRole("button", { name: /^Действия: Архитектура/ }).click();
  await expect(page.getByRole("menuitem").first()).toBeFocused();
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "В коллекцию" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("menuitem", { name: "Разработка" }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.getByRole("button", { name: "Список", exact: true }).click();
  await expect(page.locator('[data-bookmark-id="2"] [data-collection]')).toContainText("Разработка");
  // Escape closes the menu and returns focus to its button.
  const trigger = page.getByRole("button", { name: /^Действия: Архитектура/ });
  await page.locator('[data-bookmark-id="2"]').hover();
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
for (const width of [800, 1200, 1600])
  test(`layout at ${width}px and both themes`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 800 ? 550 : 800 });
    await page.getByRole("button", { name: "Настройки", exact: true }).click();
    for (const [theme, label] of [
      ["light", "Светлая"],
      ["dark", "Тёмная"],
    ]) {
      await page.getByRole("radio", { name: label }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    }
    await page.getByRole("button", { name: "Все закладки" }).click();
    await page.screenshot({ path: `test-results/library-${width}.png` });
  });
test("language switches without a restart", async ({ page }) => {
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  await page.getByLabel("Язык", { exact: true }).selectOption("en");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.getByLabel("Language", { exact: true }).selectOption("system");
  await expect(page.getByRole("heading", { name: "Настройки" })).toBeVisible();
});
test("incoming capture preserves reading position until explicitly revealed", async ({ page }) => {
  // A short window, so the six cards scroll.
  await page.setViewportSize({ width: 1200, height: 550 });
  const scroll = page.locator('[data-scroll="main"]');
  await scroll.evaluate((el) => (el.scrollTop = 180));
  const before = await scroll.evaluate((el) => el.scrollTop);
  expect(before).toBeGreaterThan(20);
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const incoming = await api.addBookmark({
      url: "https://example.com/incoming",
      title: "Incoming capture",
    });
    await api.updateBookmark(incoming.id, {
      notes: "Метаданные поступили до следующего кадра",
    });
  });
  await expect(page.getByRole("button", { name: "Новые закладки · 1" })).toBeVisible();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(6);
  expect(await scroll.evaluate((el) => el.scrollTop)).toBe(before);
  await page.getByRole("button", { name: "Новые закладки · 1" }).click();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(7);
  expect(await scroll.evaluate((el) => el.scrollTop)).toBe(0);
});
test("metadata updates keep order and filtered captures stay out of the list", async ({ page }) => {
  const ids = await page
    .locator("[data-bookmark-id]")
    .evaluateAll((elements) => elements.map((e) => e.getAttribute("data-bookmark-id")));
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    await api.updateBookmark(3, { notes: "Updated asynchronously" });
  });
  expect(
    await page.locator("[data-bookmark-id]").evaluateAll((elements) => elements.map((e) => e.getAttribute("data-bookmark-id"))),
  ).toEqual(ids);
  await page.getByRole("button", { name: "Избранное 2" }).click();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(2);
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    await api.addBookmark({
      url: "https://example.com/not-a-favorite",
      title: "Not a favorite",
    });
  });
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(2);
});
test("an older search response cannot replace the current query", async ({ page }) => {
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const original = api.getBookmarks;
    api.getBookmarks = async (filters) => {
      const rows = await original(filters);
      if (filters?.search === "Архитектура") await new Promise((resolve) => setTimeout(resolve, 450));
      return rows;
    };
  });
  await page.getByRole("textbox", { name: "Поиск в библиотеке" }).fill("Архитектура");
  await page.waitForTimeout(190);
  await page.getByRole("textbox", { name: "Поиск в библиотеке" }).fill("Типографика");
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(1);
  await page.waitForTimeout(500);
  await expect(page.locator('[data-bookmark-id="3"]')).toBeVisible();
});

test("list geometry stays within the window and broken previews keep their space", async ({ page }) => {
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const data = {
      bookmarks: (await api.getBookmarks()).items,
      collections: await api.getCollections(),
    };
    data.bookmarks[0].image_url = "/broken-preview.png";
    data.bookmarks[0].title = "Очень длинный заголовок ".repeat(12);
    localStorage.setItem("netamipin.demo.v2", JSON.stringify(data));
  });
  await page.reload();
  await expect(page.locator('[data-bookmark-id="1"] [data-preview-fallback]')).toBeVisible();
  await page.getByRole("button", { name: "Список", exact: true }).click();
  const preview = await page.locator('[data-bookmark-id="1"] [data-preview]').boundingBox();
  expect(preview?.width).toBe(64);
  expect(preview?.height).toBe(44);
  expect(await page.locator('[data-scroll="main"]').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await page.locator('[data-bookmark-id="1"]').evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
});

test("save errors preserve entered data and HTML import skips duplicate and unsupported links", async ({ page }) => {
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const original = api.addBookmark;
    let failed = false;
    api.addBookmark = async (data) => {
      if (!failed) {
        failed = true;
        throw new Error("Не удалось записать ссылку");
      }
      return original(data);
    };
  });
  await page.getByRole("button", { name: "Добавить ссылку", exact: true }).click();
  await page.getByLabel("Ссылка", { exact: true }).fill("https://example.com/new-link");
  await page.getByLabel("Название", { exact: true }).fill("Моя находка");
  await page.getByRole("button", { name: "Сохранить ссылку" }).click();
  await expect(page.getByRole("alert")).toContainText("Не удалось записать");
  await expect(page.getByLabel("Название", { exact: true })).toHaveValue("Моя находка");
  await page.getByRole("button", { name: "Сохранить ссылку" }).click();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(7);
  await page.getByRole("button", { name: "Ещё", exact: true }).click();
  await page.getByRole("menuitem", { name: /Закладки браузера/ }).click();
  await page.locator("input[type=file]").setInputFiles({
    name: "bookmarks.html",
    mimeType: "text/html",
    buffer: Buffer.from(
      '<a href="https://example.com/new-link">Duplicate</a><a href="https://example.com/imported">Импортировано</a><a href="javascript:alert(1)">Unsupported</a>',
    ),
  });
  await page.getByRole("button", { name: "Импортировать", exact: true }).click();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(8);
  await expect(page.getByRole("status")).toContainText("Новых ссылок: 1");
});

test("a large library loads page by page while scrolling", async ({ page }) => {
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const [first] = (await api.getBookmarks()).items;
    const bookmarks = Array.from({ length: 250 }, (_, i) => ({
      ...first,
      id: i + 1,
      url: `https://example.com/${i + 1}`,
      title: i % 2 ? `Ёлка ${i + 1}` : `Запись ${i + 1}`,
      tags: [],
      // Every fifth one shares a time with its neighbour: the id breaks the tie.
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 250 - i + (i % 5 === 0 ? 1 : 0))).toISOString(),
    }));
    localStorage.setItem("netamipin.demo.v2", JSON.stringify({ bookmarks, collections: await api.getCollections() }));
  });
  await page.reload();
  const cards = page.locator("[data-bookmark-id]");
  await expect(cards).toHaveCount(100);
  const scroll = page.locator('[data-scroll="main"]');
  await scroll.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(cards).toHaveCount(200);
  await scroll.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(cards).toHaveCount(250);
  const ids = await cards.evaluateAll((elements) => elements.map((e) => Number(e.getAttribute("data-bookmark-id"))));
  expect(new Set(ids).size).toBe(250);

  // «е» finds «Ёлка»; the count covers every page, not only the loaded one.
  await page.getByRole("textbox", { name: "Поиск в библиотеке" }).fill("елка");
  await expect(page.getByText("125 из 250")).toBeVisible();
  await expect(cards).toHaveCount(100);
});

/** 250 demo bookmarks, newest first by id; odd ones are titled «Ёлка». */
async function largeLibrary(page: import("@playwright/test").Page) {
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const [first] = (await api.getBookmarks()).items;
    const bookmarks = Array.from({ length: 250 }, (_, i) => ({
      ...first,
      id: i + 1,
      url: `https://example.com/${i + 1}`,
      title: `Запись ${i + 1}`,
      tags: [],
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    }));
    localStorage.setItem("netamipin.demo.v2", JSON.stringify({ bookmarks, collections: await api.getCollections() }));
  });
  await page.reload();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(100);
}

test("a change during a page request shows the newer version", async ({ page }) => {
  await largeLibrary(page);
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const original = api.getBookmarks;
    api.getBookmarks = async (filters, request) => {
      const result = await original(filters, request);
      // The page is read, then bookmark 100 (on it) changes before it arrives.
      if (request?.after) {
        await api.updateBookmark(100, { title: "Изменено во время загрузки" });
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return result;
    };
  });
  await page.locator('[data-scroll="main"]').evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(200);
  await expect(page.locator('[data-bookmark-id="100"]')).toContainText("Изменено во время загрузки");
});

test("a failing next page is not retried in a loop", async ({ page }) => {
  await largeLibrary(page);
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const original = api.getBookmarks;
    (window as unknown as { failures: number }).failures = 0;
    api.getBookmarks = async (filters, request) => {
      if (request?.after) {
        (window as unknown as { failures: number }).failures++;
        throw new Error("Диск недоступен");
      }
      return original(filters, request);
    };
  });
  await page.locator('[data-scroll="main"]').evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(page.getByText("Диск недоступен")).toBeVisible();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as unknown as { failures: number }).failures)).toBe(1);
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(100);
});

test("a changed bookmark joins an open search by the search rules", async ({ page }) => {
  const search = page.getByRole("textbox", { name: "Поиск в библиотеке" });
  await search.fill("ёлочн ИГРУШКИ");
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(0);
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    await api.updateBookmark(3, { notes: "Игрушки для елочных базаров" });
  });
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(1);
  await expect(page.locator('[data-bookmark-id="3"]')).toBeVisible();
  await expect(page.getByText("1 из 6")).toBeVisible();
});