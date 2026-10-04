import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.removeItem("netamipin.demo.v4"));
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
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
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
  // Escape closes the menu and returns focus to its button.
  const trigger = page.getByRole("button", { name: /^Действия: Архитектура/ });
  await page.locator('[data-bookmark-id="2"]').hover();
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.getByRole("button", { name: "Список", exact: true }).click();
  await expect(page.locator('[data-bookmark-id="2"] [data-collection]')).toContainText("Разработка");
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
    const { bookmark: incoming } = await api.addBookmark({
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
test("inbox: new links wait there until a decision, the banner hides until a newer one", async ({ page }) => {
  const inbox = (count: number) => page.getByRole("button", { name: `Входящие ${count}`, exact: true });
  const banner = page.getByRole("region", { name: "Новые закладки" });
  const cards = page.locator("[data-bookmark-id]");
  const capture = (url: string) =>
    page.evaluate(async (url) => {
      const { api } = await import("/src/services/api.ts");
      await api.addBookmark({ url, title: "Из браузера" });
    }, url);
  // All bookmarks include the inbox; the banner leads there.
  await expect(inbox(2)).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Все закладки\s*6/);
  await expect(banner).toContainText("2 новые закладки ждут разбора — оставить, разложить или выбросить займёт около минуты");
  await banner.getByRole("button", { name: "Разобрать" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Входящие\s*2/);
  await expect(cards).toHaveCount(2);
  await expect(banner).toHaveCount(0);
  // Search stays in the section.
  await page.getByRole("textbox", { name: "Поиск в библиотеке" }).fill("тишины");
  await expect(cards).toHaveCount(1);
  await expect(page.getByText("1 из 2")).toBeVisible();
  await page.getByRole("textbox", { name: "Поиск в библиотеке" }).fill("");
  // A capture is in the inbox and its counter at once.
  await capture("https://example.com/captured");
  await expect(cards).toHaveCount(3);
  await expect(inbox(3)).toBeVisible();
  // A decision, here the star, takes a bookmark out of the inbox.
  await page.locator('[data-bookmark-id="2"]').hover();
  await page.locator('[data-bookmark-id="2"]').getByRole("button", { name: "В избранное" }).click();
  await expect(cards).toHaveCount(2);
  await expect(inbox(2)).toBeVisible();
  await expect(page.getByRole("button", { name: "Избранное 3" })).toBeVisible();

  // Hidden until a bookmark newer than the ones waiting arrives, also after a restart.
  await page.getByRole("button", { name: "Все закладки" }).click();
  await banner.getByRole("button", { name: "Скрыть до новых закладок" }).click();
  await expect(banner).toHaveCount(0);
  await page.reload();
  await expect(cards).toHaveCount(7);
  await expect(banner).toHaveCount(0);
  await expect(inbox(2)).toBeVisible();
  await capture("https://example.com/newer");
  await expect(banner).toContainText("3 новые закладки ждут разбора");

  // Nothing left: no banner, no badge, the empty inbox.
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    for (const b of (await api.getBookmarks({ onlyInbox: true })).items) await api.updateBookmark(b.id, { notes: "Решено" });
  });
  await expect(banner).toHaveCount(0);
  await page.getByRole("button", { name: "Входящие", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Всё разобрано" })).toBeVisible();
});
test("trash: delete without a dialog, undo, restore with every field, a link saved again comes back", async ({ page }) => {
  const nav = (name: string) => page.getByRole("button", { name, exact: true });
  const cards = page.locator("[data-bookmark-id]");
  const toast = page.locator(".fixed[role=status]");
  // The context menu works on a card and on a row alike.
  const trashCard = async (id: number) => {
    await page.locator(`[data-bookmark-id="${id}"]`).click({ button: "right" });
    await page.getByRole("menuitem", { name: "В корзину" }).click();
  };
  // The undo notice: its button, then Ctrl Z.
  await trashCard(1);
  await expect(toast).toContainText("Перемещено в корзину");
  await expect(cards).toHaveCount(5);
  await toast.getByRole("button", { name: /Отменить/ }).click();
  await expect(cards).toHaveCount(6);
  await trashCard(1);
  await expect(nav("Корзина 1")).toBeVisible();
  await page.keyboard.press("Control+z");
  await expect(toast).toContainText("Восстановлено");
  await expect(nav("Корзина 0")).toBeVisible();

  // In the trash: out of counts and search, newest deletion first, days left, the note.
  await trashCard(3);
  await trashCard(1);
  await expect(nav("Избранное 0")).toBeVisible();
  await expect(nav("Все закладки 4")).toBeVisible();
  await expect(nav("Дизайн 0")).toBeVisible();
  await page.getByRole("textbox", { name: "Поиск в библиотеке" }).fill("принципов");
  await expect(cards).toHaveCount(0);
  await page.getByRole("textbox", { name: "Поиск в библиотеке" }).fill("");
  await nav("Корзина 2").click();
  await expect(page.getByText(/«Восстановить» вернёт закладку с заметкой/)).toBeVisible();
  await expect(page.getByRole("region", { name: "Новые закладки" })).toHaveCount(0);
  await expect(cards.first()).toHaveAttribute("data-bookmark-id", "1");
  await expect(cards.first()).toContainText("ещё 30 дней");
  await page.getByRole("textbox", { name: "Поиск в библиотеке" }).fill("типографика");
  await expect(cards).toHaveCount(1);
  await page.getByRole("textbox", { name: "Поиск в библиотеке" }).fill("");

  // Restore brings back the star, the collection and the tags.
  await page.getByRole("button", { name: "Список", exact: true }).click();
  const row = page.locator('[data-bookmark-id="1"]');
  await row.hover();
  await row.getByRole("button", { name: "Восстановить" }).click();
  await expect(cards).toHaveCount(1);
  await nav("Избранное 1").click();
  await expect(row).toContainText("Дизайн");
  await expect(row.getByRole("button", { name: "принципы" })).toBeVisible();

  // Added again by hand: back from the trash, waiting in the inbox.
  await page.getByRole("button", { name: "Добавить ссылку", exact: true }).click();
  await page.getByLabel("Ссылка", { exact: true }).fill("https://type.today/ru");
  await page.getByRole("button", { name: "Сохранить ссылку" }).click();
  await expect(toast).toContainText("Возвращено из корзины во «Входящие»");
  await expect(nav("Корзина 0")).toBeVisible();
  await expect(nav("Входящие 3")).toBeVisible();

  // An import leaves a link in the trash where it is and says so.
  await trashCard(3);
  await page.getByRole("button", { name: "Ещё", exact: true }).click();
  await page.getByRole("menuitem", { name: /Закладки браузера/ }).click();
  await page.locator("input[type=file]").setInputFiles({
    name: "bookmarks.html",
    mimeType: "text/html",
    buffer: Buffer.from('<a href="https://type.today/ru">Типографика</a>'),
  });
  await page.getByRole("button", { name: "Импортировать", exact: true }).click();
  await expect(toast).toContainText("Новых ссылок: 0 · в корзине осталось: 1");
  await expect(nav("Корзина 1")).toBeVisible();
  await nav("Корзина 1").click();
  await page.locator('[data-bookmark-id="3"]').hover();
  await page.locator('[data-bookmark-id="3"]').getByRole("button", { name: "Восстановить" }).click();
  await expect(page.getByRole("heading", { name: "Корзина пуста" })).toBeVisible();
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
    localStorage.setItem("netamipin.demo.v4", JSON.stringify(data));
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
    localStorage.setItem("netamipin.demo.v4", JSON.stringify({ bookmarks, collections: await api.getCollections() }));
  });
  await page.reload();
  // Virtualized: only rows near the screen are in the DOM; `data-loaded` counts the pages read.
  const list = page.locator("[data-loaded]");
  await expect(list).toHaveAttribute("data-loaded", "100");
  expect(await page.locator("[data-bookmark-id]").count()).toBeLessThan(60);
  const scroll = page.locator('[data-scroll="main"]');
  await scroll.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(list).toHaveAttribute("data-loaded", "200");
  await scroll.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(list).toHaveAttribute("data-loaded", "250");
  await scroll.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  // The oldest bookmark (id 250 here: the list starts with id 1) ends the list.
  await expect(page.locator('[data-bookmark-id="250"]')).toBeVisible();
  await expect(page.locator("[data-bookmark-id]").last()).toHaveAttribute("data-bookmark-id", "250");

  // «е» finds «Ёлка»; the count covers every page, not only the loaded one.
  await page.getByRole("textbox", { name: "Поиск в библиотеке" }).fill("елка");
  await expect(page.getByText("125 из 250")).toBeVisible();
  await expect(list).toHaveAttribute("data-loaded", "100");
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
    localStorage.setItem("netamipin.demo.v4", JSON.stringify({ bookmarks, collections: await api.getCollections() }));
  });
  await page.reload();
  await expect(page.locator("[data-loaded]")).toHaveAttribute("data-loaded", "100");
}

test("a change during a page request shows the newer version", async ({ page }) => {
  await largeLibrary(page);
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const original = api.getBookmarks;
    api.getBookmarks = async (filters, request) => {
      const result = await original(filters, request);
      // The page is read, then bookmark 150 (first on it) changes before it arrives.
      if (request?.after && request.after.id === 151) {
        await api.updateBookmark(150, { title: "Изменено во время загрузки" });
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return result;
    };
  });
  await page.locator('[data-scroll="main"]').evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(page.locator("[data-loaded]")).toHaveAttribute("data-loaded", /^(200|250)$/);
  await expect(page.locator('[data-bookmark-id="150"]')).toContainText("Изменено во время загрузки");
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
  await expect(page.locator("[data-loaded]")).toHaveAttribute("data-loaded", "100");
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

test("list rows: date groups over all pages, hover actions, inactive checkbox", async ({ page }) => {
  await page.clock.setFixedTime(new Date(2026, 9, 3, 12, 0));
  await largeLibrary(page);
  await page.getByRole("button", { name: "Список", exact: true }).click();
  // 250 bookmarks from January: one group «Раньше» sized by the database, not by the 100 loaded rows.
  await expect(page.getByRole("heading", { name: "Раньше 250" })).toBeVisible();

  const row = page.locator('[data-bookmark-id="250"]');
  await row.hover();
  const checkbox = row.getByRole("checkbox");
  await expect(checkbox).toHaveAttribute("aria-disabled", "true");
  await row.getByRole("button", { name: "В коллекцию" }).click();
  await page.getByRole("menuitem", { name: "Разработка" }).click();
  await expect(row.locator("[data-collection]")).toContainText("Разработка");
  await row.hover();
  await row.getByRole("button", { name: "В корзину" }).click();
  await expect(page.locator('[data-bookmark-id="250"]')).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Раньше 249" })).toBeVisible();
});

test("a click on a domain filters by site; Esc clears the search; nothing found offers the whole library", async ({ page }) => {
  await page.locator('[data-bookmark-id="1"]').getByRole("button", { name: "Только закладки с vitsoe.com" }).click();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("1 из 6");
  await page.getByRole("button", { name: "Убрать фильтр по сайту vitsoe.com" }).click();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(6);

  const search = page.getByRole("textbox", { name: "Поиск в библиотеке" });
  await page.getByRole("button", { name: /^Вдохновение/ }).click();
  await search.fill("типографика");
  await expect(page.getByRole("heading", { name: "В «Вдохновение» ничего не нашлось по «типографика»" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("0 из 2");
  await expect(page.locator("label kbd")).toHaveText("Esc");
  await page.getByRole("button", { name: "Искать во всей библиотеке" }).click();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(1);
  await expect(search).toHaveValue("типографика");
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(6);
});

test("editor: empty title is marked, tags are chips, Ctrl Enter saves, Cancel keeps the bookmark", async ({ page }) => {
  const card = page.locator('[data-bookmark-id="1"]');
  await card.hover();
  await card.getByRole("button", { name: /^Действия:/ }).click();
  await page.getByRole("menuitem", { name: "Изменить…" }).click();
  const title = page.getByLabel("Название", { exact: true });
  await title.fill("");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(title).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Название не может быть пустым")).toBeVisible();
  await expect(title).toBeFocused();

  await title.fill("Десять принципов");
  const tags = page.getByLabel("Теги", { exact: true });
  await page.getByRole("button", { name: "Убрать тег принципы" }).click();
  await tags.fill("Рамс");
  await tags.press("Enter");
  await tags.fill("braun");
  // Ctrl Enter saves from any field and keeps the tag still being typed.
  await tags.press("Control+Enter");
  await expect(page.getByRole("status")).toContainText("Изменения сохранены");
  await page.getByRole("button", { name: "Список", exact: true }).click();
  const row = page.locator('[data-bookmark-id="1"]');
  await expect(row).toContainText("Десять принципов");
  await expect(row.getByRole("button", { name: "рамс" })).toBeVisible();
  await expect(row.getByRole("button", { name: "braun" })).toBeVisible();
  await expect(row.getByRole("button", { name: "принципы" })).toHaveCount(0);

  await row.hover();
  await row.getByRole("button", { name: /^Открыть:/ }).first().focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Изменить…" }).click();
  await page.getByLabel("Название", { exact: true }).fill("Не сохранится");
  await page.getByRole("button", { name: "Отмена", exact: true }).click();
  await expect(row).toContainText("Десять принципов");
  await row.hover();
  await row.getByRole("button", { name: /^Открыть:/ }).first().focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Изменить…" }).click();
  // No confirmation: the bookmark goes to the trash and the editor closes.
  const editor = page.getByRole("complementary", { name: "Изменить закладку" });
  await editor.getByRole("button", { name: "В корзину" }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Перемещено в корзину");
  await expect(page.locator('[data-bookmark-id="1"]')).toHaveCount(0);
});

test("editor: a failed save shows the reason and keeps everything typed", async ({ page }) => {
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const { CommandError } = await import("/src/services/errors.ts");
    const original = api.updateBookmark;
    let failed = false;
    api.updateBookmark = async (id, data) => {
      if (!failed) {
        failed = true;
        throw new CommandError("database_busy", "busy");
      }
      return original(id, data);
    };
  });
  const card = page.locator('[data-bookmark-id="2"]');
  await card.hover();
  await card.getByRole("button", { name: /^Действия:/ }).click();
  await page.getByRole("menuitem", { name: "Изменить…" }).click();
  await page.getByLabel("Название", { exact: true }).fill("Тишина и свет");
  await page.getByLabel("Заметка", { exact: true }).fill("Перечитать зимой");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Не удалось сохранить — изменения остались в форме.");
  await expect(page.getByLabel("Название", { exact: true })).toHaveValue("Тишина и свет");
  await expect(page.getByLabel("Заметка", { exact: true })).toHaveValue("Перечитать зимой");
  await page.getByRole("button", { name: "Сохранить ещё раз", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Изменения сохранены");
  await expect(page.locator('[data-bookmark-id="2"]')).toContainText("Тишина и свет");
});
test("connect dialog: steps for each browser, no token and no bookmarklet", async ({ page }) => {
  await page.getByRole("button", { name: "Браузер не подключён" }).click();
  const dialog = page.getByRole("dialog", { name: "Подключить браузер" });
  await expect(dialog.locator('[data-capture="none"]')).toContainText("Браузер не подключён");
  await expect(dialog).toContainText("extension/build/chrome");
  await dialog.getByRole("radio", { name: "Edge" }).click();
  await expect(dialog).toContainText("edge://extensions");
  await dialog.getByRole("radio", { name: "Firefox" }).click();
  await expect(dialog).toContainText("netamipin-firefox.xpi");
  await expect(dialog).toContainText("about:addons");
  await expect(dialog).not.toContainText(/токен|букмарклет/i);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  const block = page.locator('[data-capture="none"]');
  await expect(block).toContainText("Расширение сохраняет страницу одним нажатием");
  await block.getByRole("button", { name: "Подключить", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Подключить браузер" })).toBeVisible();
});
